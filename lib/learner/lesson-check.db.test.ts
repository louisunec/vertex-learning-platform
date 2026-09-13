import assert from 'node:assert/strict'
import {after, before, beforeEach, describe, it} from 'node:test'

import {createTestDatabase, SKIP_WITHOUT_DATABASE, type TestDatabase} from '../db/test-db.ts'
import {submitAttempt} from './attempts.ts'
import type {LessonCheckRequest, LessonCheckResponse} from './contracts.ts'
import {requestHelp} from './help.ts'
import {nextLessonTask} from './lesson-check.ts'
import {FixtureContent} from './test-content.ts'

/**
 * `nextLessonTask` against a real migrated database under the RLS-bound
 * learner role, with in-memory content. Covers ownership, resumption,
 * expiry, the honest "none" states, and the loop the check exists for: an
 * assisted learner who takes the same-concept follow-up ends with a
 * different evidence history from a learner who answered on their own.
 */

const ALICE = 'user_alice'
const BOB = 'user_bob'
const LESSON = 'lesson-hooks'
const NOW = new Date('2026-09-13T10:00:00.000Z')
const LATER = new Date(NOW.getTime() + 25 * 60 * 60 * 1000)

let keySeq = 0
const key = () => `key-${String(++keySeq).padStart(16, '0')}`

describe('nextLessonTask', {skip: SKIP_WITHOUT_DATABASE}, () => {
  let db: TestDatabase
  let content: FixtureContent

  before(async () => {
    db = await createTestDatabase()
  })
  after(() => db?.drop())

  beforeEach(async () => {
    await db.sql`truncate learner.review_session_item, learner.review_session, learner.tutor_request, learner.event_outbox, learner.concept_mastery, learner.help_event, learner.attempt_log, learner.task_instance`
    content = new FixtureContent()
    content.concepts.set('concept-cpt-state', {id: 'concept-cpt-state', conceptId: 'cpt-state', reviewStatus: 'approved'})
    // Two items on the same concept, one without a concept, and one in another lesson.
    content.addItem('fam-a', {firstSeconds: 10})
    content.addItem('fam-b', {firstSeconds: 50})
    content.addItem('fam-c', {firstSeconds: 30, concept: null})
    content.addItem('fam-other', {lessonId: 'lesson-other'})
  })

  const next = async (learnerId: string, request: LessonCheckRequest, now = NOW): Promise<LessonCheckResponse> => {
    const outcome = await nextLessonTask({db: db.sql, content, learnerId, request, now})
    assert.equal(outcome.status, 'ok', JSON.stringify(outcome))
    return outcome.status === 'ok' ? outcome.body : assert.fail()
  }
  const check = (learnerId: string, now = NOW) => next(learnerId, {lessonId: LESSON, kind: 'check'}, now)
  const followUp = (learnerId: string, afterTaskInstanceId: string) =>
    next(learnerId, {lessonId: LESSON, kind: 'follow_up', afterTaskInstanceId})
  const issued = (body: LessonCheckResponse) => (body.status === 'issued' ? body : assert.fail(`expected a question, got ${JSON.stringify(body)}`))

  const answer = async (learnerId: string, taskInstanceId: string, optionId = 'opt-a') => {
    const outcome = await submitAttempt({db: db.sql, content, learnerId, request: {taskInstanceId, optionId, idempotencyKey: key()}, now: NOW})
    return outcome.status === 'graded' ? outcome.body : assert.fail(JSON.stringify(outcome))
  }

  it('walks the lesson one concept at a time, resuming an unanswered question instead of duplicating it', async () => {
    const first = issued(await check(ALICE))
    assert.deepEqual([first.task.item.familyId, first.resumed, first.progress], ['fam-a', false, {remaining: 2, total: 2}])

    const again = issued(await check(ALICE))
    assert.deepEqual([again.task.taskInstanceId, again.resumed], [first.task.taskInstanceId, true])

    await answer(ALICE, first.task.taskInstanceId)
    const second = issued(await check(ALICE))
    // fam-b shares fam-a's concept, so it is held back for a follow-up.
    assert.deepEqual([second.task.item.familyId, second.progress], ['fam-c', {remaining: 1, total: 2}])

    await answer(ALICE, second.task.taskInstanceId)
    assert.deepEqual(await check(ALICE), {status: 'none', kind: 'check', reason: 'all_checked'})
    const [{instances}] = await db.sql<{instances: number}[]>`select count(*)::int as instances from learner.task_instance`
    assert.equal(instances, 2)
  })

  it('issues a fresh instance once the unanswered one has expired', async () => {
    const first = issued(await check(ALICE))
    const later = issued(await check(ALICE, LATER))
    assert.equal(later.task.item.familyId, 'fam-a')
    assert.notEqual(later.task.taskInstanceId, first.task.taskInstanceId)
    assert.equal(later.resumed, false)
  })

  it('reports a lesson without reviewed items as no_items', async () => {
    assert.deepEqual(await next(ALICE, {lessonId: 'lesson-empty', kind: 'check'}), {status: 'none', kind: 'check', reason: 'no_items'})
  })

  it('offers a same-concept variant only after an answer, only to its owner, and only in its lesson', async () => {
    const first = issued(await check(ALICE))
    const after = (learnerId: string, lessonId = LESSON) =>
      nextLessonTask({db: db.sql, content, learnerId, request: {lessonId, kind: 'follow_up', afterTaskInstanceId: first.task.taskInstanceId}, now: NOW})

    assert.deepEqual(await after(ALICE), {status: 'rejected', code: 'invalid_request'})
    await answer(ALICE, first.task.taskInstanceId, 'opt-b')
    assert.deepEqual(await after(BOB), {status: 'rejected', code: 'not_found'})
    assert.deepEqual(await after(ALICE, 'lesson-other'), {status: 'rejected', code: 'not_found'})

    const variant = issued(await followUp(ALICE, first.task.taskInstanceId))
    assert.deepEqual([variant.kind, variant.task.item.familyId, variant.progress], ['follow_up', 'fam-b', null])

    await answer(ALICE, variant.task.taskInstanceId)
    assert.deepEqual(await followUp(ALICE, variant.task.taskInstanceId), {status: 'none', kind: 'follow_up', reason: 'no_variant'})
  })

  it('has no variant for an item without a reviewed concept', async () => {
    await answer(ALICE, issued(await check(ALICE)).task.taskInstanceId)
    const loose = issued(await check(ALICE))
    await answer(ALICE, loose.task.taskInstanceId, 'opt-b')
    assert.deepEqual(await followUp(ALICE, loose.task.taskInstanceId), {status: 'none', kind: 'follow_up', reason: 'no_variant'})
  })

  it('gives an assisted learner who takes the follow-up a different evidence history from an independent one', async () => {
    // Alice answers on her own.
    const alice = issued(await check(ALICE))
    assert.deepEqual((await answer(ALICE, alice.task.taskInstanceId)).evidence, {kind: 'independent', reasonCode: 'first_independent_response'})

    // Bob takes a hint, answers, then answers the unseen variant without help.
    const bob = issued(await check(BOB))
    const help = await requestHelp({
      db: db.sql,
      content,
      learnerId: BOB,
      request: {taskInstanceId: bob.task.taskInstanceId, mode: 'study', request: 'hint', requestKey: key()},
    })
    assert.equal(help.status === 'helped' && help.body.level, 1)
    assert.deepEqual((await answer(BOB, bob.task.taskInstanceId)).evidence, {kind: 'assisted', reasonCode: 'hint_used'})
    const variant = issued(await followUp(BOB, bob.task.taskInstanceId))
    assert.deepEqual((await answer(BOB, variant.task.taskInstanceId)).evidence, {kind: 'independent', reasonCode: 'first_independent_response'})

    const history = await db.sql<{learnerId: string; familyId: string; kind: string; hint: number}[]>`
      select learner_id as "learnerId", family_id as "familyId", evidence_kind as kind, hint_level_used as hint
      from learner.attempt_log order by created_at, id
    `
    assert.deepEqual(
      history.filter((row) => row.learnerId === ALICE).map(({familyId, kind, hint}) => [familyId, kind, hint]),
      [['fam-a', 'independent', 0]],
    )
    assert.deepEqual(
      history.filter((row) => row.learnerId === BOB).map(({familyId, kind, hint}) => [familyId, kind, hint]),
      [
        ['fam-a', 'assisted', 1],
        ['fam-b', 'independent', 0],
      ],
    )

    const mastery = await db.sql`
      select learner_id, independent_correct, assisted_correct, evidence_status
      from learner.concept_mastery where concept_id = 'cpt-state' order by learner_id
    `
    assert.deepEqual(
      mastery.map((row) => ({...row})),
      [
        {learner_id: ALICE, independent_correct: 1, assisted_correct: 0, evidence_status: 'independent'},
        {learner_id: BOB, independent_correct: 1, assisted_correct: 1, evidence_status: 'independent'},
      ],
    )
  })

  it('never returns an answer key, hints, or the selection inputs', async () => {
    const first = issued(await check(ALICE))
    await answer(ALICE, first.task.taskInstanceId, 'opt-b')
    const bodies = [first, await check(ALICE), await followUp(ALICE, first.task.taskInstanceId), await check(ALICE)]
    const json = JSON.stringify(bodies)
    for (const leak of ['correctOptionId', 'answerKey', 'hints', 'direction', 'keyConcept', 'solution', 'primaryConcept', 'firstSeconds', 'cpt-state']) {
      assert.ok(!json.includes(leak), `leaked ${leak}`)
    }
  })
})
