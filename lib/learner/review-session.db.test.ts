import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {after, before, beforeEach, describe, it} from 'node:test'

import {asLearner} from '../db/learner-scope.ts'
import {createTestDatabase, SKIP_WITHOUT_DATABASE, type TestDatabase} from '../db/test-db.ts'
import {submitAttempt} from './attempts.ts'
import type {ReviewSessionResponse} from './contracts.ts'
import {requestHelp} from './help.ts'
import {openRefresher, startReviewSession} from './review-session.ts'
import {issueTask} from './task-instances.ts'
import {FixtureContent} from './test-content.ts'

/**
 * The focused review against the real schema, as the web app's RLS-bound
 * role: a session is built from the learner's own recent mistakes with
 * unseen questions only, resumed rather than duplicated (also under
 * concurrency), its progress read from graded attempts, and its refresher
 * recorded as help that makes the next answer assisted without moving the
 * hint ladder.
 */

const ALICE = 'user_alice'
const BOB = 'user_bob'
const HOUR = 60 * 60 * 1000

type Active = Extract<ReviewSessionResponse, {status: 'active'}>

describe('focused review sessions', {skip: SKIP_WITHOUT_DATABASE}, () => {
  let db: TestDatabase
  let content: FixtureContent

  before(async () => {
    db = await createTestDatabase()
  })
  after(() => db?.drop())

  beforeEach(async () => {
    await db.sql`
      truncate learner.review_session_item, learner.review_session, learner.tutor_request, learner.event_outbox,
               learner.help_event, learner.concept_mastery, learner.attempt_log, learner.task_instance
    `
    content = new FixtureContent()
    content.concepts.set('concept-cpt-state', {id: 'concept-cpt-state', conceptId: 'cpt-state', reviewStatus: 'approved'})
    content.names.set('concept-cpt-state', 'State')
    content.addItem('fam1')
    content.seconds.set(content.addItem('fam2'), 100)
    content.seconds.set(content.addItem('fam3'), 10)
  })

  const start = (learnerId = ALICE, now = new Date()) => startReviewSession({db: db.sql, content, learnerId, now})

  async function answer(learnerId: string, taskInstanceId: string, optionId: string) {
    const outcome = await submitAttempt({
      db: db.sql,
      content,
      learnerId,
      request: {taskInstanceId, optionId, idempotencyKey: randomUUID()},
      now: new Date(),
    })
    assert.equal(outcome.status, 'graded')
    return outcome.status === 'graded' ? outcome.body : assert.fail('not graded')
  }

  /** A graded first answer on `familyId`, as the lesson check would record it. */
  async function answerFamily(learnerId: string, familyId: string, optionId: string) {
    const issued = await issueTask({db: db.sql, content, learnerId, assessmentId: `assessment-${familyId}-v1`, now: new Date()})
    assert.equal(issued.status, 'issued')
    return answer(learnerId, issued.status === 'issued' ? issued.body.taskInstanceId : '', optionId)
  }

  async function active(learnerId = ALICE, now?: Date): Promise<Active> {
    const body = await start(learnerId, now)
    assert.equal(body.status, 'active')
    return body as Active
  }

  const openTask = (session: Active, position: number) => {
    const item = session.items[position - 1]
    return item.state === 'open' ? item.task.taskInstanceId : assert.fail(`item ${position} is ${item.state}`)
  }

  it('says there is nothing to review without a recent mistake', async () => {
    assert.deepEqual(await start(), {status: 'none', reason: 'no_recent_mistakes'})
    await answerFamily(ALICE, 'fam1', 'opt-a')
    assert.deepEqual(await start(), {status: 'none', reason: 'no_recent_mistakes'})
  })

  it('builds a session from a missed concept with its unseen questions, in cited order', async () => {
    await answerFamily(ALICE, 'fam1', 'opt-b')
    const session = await active()
    assert.equal(session.resumed, false)
    assert.deepEqual(session.concepts, [{conceptId: 'cpt-state', name: 'State', reason: 'independent_incorrect'}])
    assert.deepEqual(
      session.items.map((item) => [item.position, item.state, item.state === 'open' && item.task.item.familyId]),
      [
        [1, 'open', 'fam3'],
        [2, 'open', 'fam2'],
      ],
    )
    assert.deepEqual(session.items[0].state === 'open' && session.items[0].refresher, {lessonTitle: 'Hooks', startSeconds: 10})
  })

  it('resumes the same session and reads progress from graded attempts', async () => {
    await answerFamily(ALICE, 'fam1', 'opt-b')
    const first = await active()
    const again = await active()
    assert.equal(again.resumed, true)
    assert.equal(again.sessionId, first.sessionId)
    assert.equal(openTask(again, 1), openTask(first, 1))

    await answer(ALICE, openTask(first, 1), 'opt-a')
    const resumed = await active()
    assert.equal(resumed.sessionId, first.sessionId)
    assert.deepEqual(
      resumed.items.map((item) => item.state),
      ['answered', 'open'],
    )
    assert.equal(openTask(resumed, 2), openTask(first, 2))
  })

  it('does not resume a finished session, and says why no new one starts', async () => {
    await answerFamily(ALICE, 'fam1', 'opt-b')
    const session = await active()
    await answer(ALICE, openTask(session, 1), 'opt-b')
    await answer(ALICE, openTask(session, 2), 'opt-b')
    // Still missing the concept, but every reviewed question on it has been answered.
    assert.deepEqual(await start(), {status: 'none', reason: 'no_unseen_questions'})
  })

  it('starts a new session once the old one has expired', async () => {
    await answerFamily(ALICE, 'fam1', 'opt-b')
    const session = await active()
    const later = await active(ALICE, new Date(Date.now() + 25 * HOUR))
    assert.notEqual(later.sessionId, session.sessionId)
    assert.equal(later.resumed, false)
  })

  it('creates one session for concurrent starts', async () => {
    await answerFamily(ALICE, 'fam1', 'opt-b')
    const sessions = await Promise.all([start(), start(), start()])
    const ids = new Set(sessions.map((body) => (body.status === 'active' ? body.sessionId : null)))
    assert.equal(ids.size, 1)
    const [{n}] = await db.sql<{n: number}[]>`select count(*)::int as n from learner.review_session`
    assert.equal(n, 1)
  })

  it('marks an item withdrawn since it was issued as unavailable on resume', async () => {
    await answerFamily(ALICE, 'fam1', 'opt-b')
    await active()
    content.servable.delete('assessment-fam2-v1')
    const resumed = await active()
    assert.deepEqual(
      resumed.items.map((item) => item.state),
      ['open', 'unavailable'],
    )
  })

  it("keeps each learner's sessions private", async () => {
    await answerFamily(ALICE, 'fam1', 'opt-b')
    const session = await active()
    assert.deepEqual(await start(BOB), {status: 'none', reason: 'no_recent_mistakes'})
    const bob = await openRefresher({db: db.sql, content, learnerId: BOB, request: {taskInstanceId: openTask(session, 1), requestKey: randomUUID()}})
    assert.deepEqual(bob, {status: 'rejected', code: 'not_found'})
    const seen = await asLearner(db.sql, BOB, (tx) => tx<{n: number}[]>`select count(*)::int as n from learner.review_session_item`)
    assert.equal(seen[0].n, 0)
  })

  it('records the refresher as help once, so the answer is assisted but hints still start at the first rung', async () => {
    await answerFamily(ALICE, 'fam1', 'opt-b')
    const session = await active()
    const taskInstanceId = openTask(session, 1)
    const requestKey = randomUUID()

    const opened = await openRefresher({db: db.sql, content, learnerId: ALICE, request: {taskInstanceId, requestKey}})
    assert.equal(opened.status, 'recorded')
    assert.deepEqual(opened.status === 'recorded' && [opened.body.href, opened.body.replayed], ['/lessons/hooks?t=10', false])
    const replay = await openRefresher({db: db.sql, content, learnerId: ALICE, request: {taskInstanceId, requestKey}})
    assert.deepEqual(
      replay.status === 'recorded' && opened.status === 'recorded' && [replay.body.helpEventId, replay.body.replayed],
      [opened.status === 'recorded' && opened.body.helpEventId, true],
    )
    const events = await db.sql<{level: number; reasonCode: string}[]>`
      select level, reason_code as "reasonCode" from learner.help_event where task_instance_id = ${taskInstanceId}
    `
    assert.deepEqual([...events], [{level: 1, reasonCode: 'source_refresher'}])

    const help = await requestHelp({
      db: db.sql,
      content,
      learnerId: ALICE,
      request: {taskInstanceId, mode: 'study', request: 'hint', requestKey: randomUUID()},
    })
    assert.deepEqual(help.status === 'helped' && [help.body.level, help.body.reasonCode], [1, 'first_help'])

    const graded = await answer(ALICE, taskInstanceId, 'opt-a')
    assert.deepEqual(graded.evidence, {kind: 'assisted', reasonCode: 'hint_used'})
  })

  it('rejects a refresher key reused for a hint, without recording or revealing one', async () => {
    await answerFamily(ALICE, 'fam1', 'opt-b')
    const session = await active()
    const taskInstanceId = openTask(session, 1)
    const requestKey = randomUUID()
    await openRefresher({db: db.sql, content, learnerId: ALICE, request: {taskInstanceId, requestKey}})
    const help = await requestHelp({db: db.sql, content, learnerId: ALICE, request: {taskInstanceId, mode: 'study', request: 'hint', requestKey}})
    assert.deepEqual(help, {status: 'rejected', code: 'idempotency_key_reused'})
    const [{n}] = await db.sql<{n: number}[]>`select count(*)::int as n from learner.help_event where task_instance_id = ${taskInstanceId}`
    assert.equal(n, 1)
  })

  it('makes an answer after only the refresher assisted', async () => {
    await answerFamily(ALICE, 'fam1', 'opt-b')
    const session = await active()
    const taskInstanceId = openTask(session, 1)
    await openRefresher({db: db.sql, content, learnerId: ALICE, request: {taskInstanceId, requestKey: randomUUID()}})
    assert.equal((await answer(ALICE, taskInstanceId, 'opt-a')).evidence.kind, 'assisted')
    // The other item is untouched: its first answer is still independent evidence.
    assert.equal((await answer(ALICE, openTask(session, 2), 'opt-a')).evidence.kind, 'independent')
  })

  it('rejects refreshers that are not a sourced item of the learner’s session, recording nothing', async () => {
    await answerFamily(ALICE, 'fam1', 'opt-b')
    content.seconds.set('assessment-fam2-v1', null)
    const session = await active()
    const refresher = (taskInstanceId: string, requestKey = randomUUID()) =>
      openRefresher({db: db.sql, content, learnerId: ALICE, request: {taskInstanceId, requestKey}})

    assert.equal(session.items[1].state === 'open' && session.items[1].refresher, null)
    assert.deepEqual(await refresher(openTask(session, 2)), {status: 'rejected', code: 'not_found'})

    const outside = await issueTask({db: db.sql, content, learnerId: ALICE, assessmentId: 'assessment-fam2-v1', now: new Date()})
    assert.deepEqual(await refresher(outside.status === 'issued' ? outside.body.taskInstanceId : ''), {status: 'rejected', code: 'not_found'})

    content.lessons.delete('lesson-hooks')
    assert.deepEqual(await refresher(openTask(session, 1)), {status: 'rejected', code: 'not_found'})
    content.lessons.set('lesson-hooks', {title: 'Hooks', slug: 'hooks'})

    const hintKey = randomUUID()
    await requestHelp({db: db.sql, content, learnerId: ALICE, request: {taskInstanceId: openTask(session, 1), mode: 'study', request: 'hint', requestKey: hintKey}})
    assert.deepEqual(await refresher(openTask(session, 1), hintKey), {status: 'rejected', code: 'idempotency_key_reused'})

    const [{n}] = await db.sql<{n: number}[]>`select count(*)::int as n from learner.help_event where reason_code = 'source_refresher'`
    assert.equal(n, 0)
  })
})
