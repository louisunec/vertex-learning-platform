import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {after, before, beforeEach, describe, it} from 'node:test'

import {createTestDatabase, SKIP_WITHOUT_DATABASE, type TestDatabase} from '../db/test-db.ts'
import {submitAttempt} from './attempts.ts'
import type {ScheduledReviewResponse} from './contracts.ts'
import {requestHelp} from './help.ts'
import {startReviewSession} from './review-session.ts'
import {startScheduledReview} from './scheduled-review.ts'
import {issueTask} from './task-instances.ts'
import {FixtureContent} from './test-content.ts'

/**
 * Scheduled review against the real schema, as the web app's RLS-bound role
 * (prompts/pr-9-scheduled-review.md): it serves only due cards, prefers an
 * unseen question and labels a repeat, leaves a card without a question
 * unchanged, resumes separately from Mistakes mode, and its answers move
 * the card on. A repeated question is rated by the help on that task only.
 */

const ALICE = 'user_alice'
const NOW = new Date('2026-09-14T09:00:00.000Z')
const HOUR = 60 * 60 * 1000
const later = (hours: number) => new Date(NOW.getTime() + hours * HOUR)

type Active = Extract<ScheduledReviewResponse, {status: 'active'}>

describe('scheduled review sessions', {skip: SKIP_WITHOUT_DATABASE}, () => {
  let db: TestDatabase
  let content: FixtureContent

  before(async () => {
    db = await createTestDatabase()
  })
  after(() => db?.drop())

  beforeEach(async () => {
    await db.sql`
      truncate learner.review_log, learner.review_card, learner.review_session_item, learner.review_session,
               learner.tutor_request, learner.event_outbox, learner.help_event, learner.concept_mastery,
               learner.attempt_log, learner.task_instance
    `
    content = new FixtureContent()
    content.concepts.set('concept-cpt-state', {id: 'concept-cpt-state', conceptId: 'cpt-state', reviewStatus: 'approved'})
    content.names.set('concept-cpt-state', 'State')
    content.addItem('fam1')
    content.seconds.set(content.addItem('fam2'), 20)
  })

  const start = (now: Date) => startScheduledReview({db: db.sql, content, learnerId: ALICE, now})

  async function active(now: Date): Promise<Active> {
    const body = await start(now)
    assert.equal(body.status, 'active', JSON.stringify(body))
    return body as Active
  }

  async function answer(taskInstanceId: string, optionId: string, now: Date) {
    const outcome = await submitAttempt({
      db: db.sql,
      content,
      learnerId: ALICE,
      request: {taskInstanceId, optionId, idempotencyKey: randomUUID()},
      now,
      scheduling: true,
    })
    assert.equal(outcome.status, 'graded', JSON.stringify(outcome))
    return outcome.status === 'graded' ? outcome.body : assert.fail()
  }

  /** A first answer on `familyId` from the lesson check, which creates or rates the card. */
  async function answerFamily(familyId: string, optionId: string, now = NOW) {
    const issued = await issueTask({db: db.sql, content, learnerId: ALICE, assessmentId: `assessment-${familyId}-v1`, now})
    assert.equal(issued.status, 'issued')
    return answer(issued.status === 'issued' ? issued.body.taskInstanceId : '', optionId, now)
  }

  const openTask = (session: Active, position: number) => {
    const item = session.items[position - 1]
    return item.state === 'open' ? item : assert.fail(`item ${position} is ${item.state}`)
  }

  const card = async () =>
    (await db.sql<{reps: number; due: Date}[]>`select reps, due from learner.review_card where learner_id = ${ALICE}`)[0]

  it('says nothing is due without cards, and when the next card falls due', async () => {
    assert.deepEqual(await start(NOW), {status: 'none', mode: 'scheduled', reason: 'nothing_due', nextDueAt: null, unavailableDue: 0})
    const body = await answerFamily('fam1', 'opt-a')
    assert.equal(body.schedule?.status, 'scheduled')
    const dueAt = body.schedule?.status === 'scheduled' ? body.schedule.dueAt : ''
    assert.deepEqual(await start(NOW), {status: 'none', mode: 'scheduled', reason: 'nothing_due', nextDueAt: dueAt, unavailableDue: 0})
  })

  it('serves a due card with an unseen question first, and the answer moves the card on', async () => {
    await answerFamily('fam1', 'opt-a')
    const session = await active(later(1))
    assert.deepEqual(session.concepts, [{conceptId: 'cpt-state', name: 'State', reason: 'scheduled_due'}])
    const item = openTask(session, 1)
    assert.deepEqual([session.items.length, item.task.item.familyId, item.repeat], [1, 'fam2', false])
    assert.deepEqual(item.refresher, {lessonTitle: 'Hooks', startSeconds: 20})

    const before = await card()
    const body = await answer(item.task.taskInstanceId, 'opt-a', later(1))
    assert.equal(body.evidence.kind, 'independent')
    const after = await card()
    assert.equal(after.reps, before.reps + 1)
    assert.ok(after.due > later(1))
    assert.equal((await start(later(1))).status, 'none')
  })

  it('repeats the question answered longest ago when no unseen one is left, labelled, as a retention check only', async () => {
    await answerFamily('fam1', 'opt-a')
    await answerFamily('fam2', 'opt-a', new Date(NOW.getTime() + 60 * 1000))
    // Two Goods graduate the card to a two-day interval.
    const session = await active(later(72))
    const item = openTask(session, 1)
    assert.deepEqual([item.task.item.familyId, item.repeat], ['fam1', true])
    const body = await answer(item.task.taskInstanceId, 'opt-a', later(72))
    assert.deepEqual(body.evidence, {kind: 'not_counted', reasonCode: 'repeat_task'})
    assert.equal(body.schedule?.status, 'scheduled')
  })

  it('rates a repeat by the help on that task only, not by feedback seen after the earlier answer', async () => {
    content.servable.delete('assessment-fam2-v1')
    const first = await issueTask({db: db.sql, content, learnerId: ALICE, assessmentId: 'assessment-fam1-v1', now: NOW})
    const firstTask = first.status === 'issued' ? first.body.taskInstanceId : assert.fail()
    await answer(firstTask, 'opt-b', NOW)
    // The explanation after the missed answer is feedback on that task, not help on the next one.
    const explained = await requestHelp({db: db.sql, content, learnerId: ALICE, request: {taskInstanceId: firstTask, mode: 'study', request: 'solution', requestKey: randomUUID()}})
    assert.equal(explained.status, 'helped')

    const session = await active(later(1))
    const repeat = openTask(session, 1)
    assert.equal(repeat.repeat, true)
    assert.deepEqual((await answer(repeat.task.taskInstanceId, 'opt-a', later(1))).schedule?.status, 'scheduled')

    // A hint on the repeat itself makes a correct answer unrated.
    const next = await active(later(100))
    const hinted = openTask(next, 1).task.taskInstanceId
    const hint = await requestHelp({db: db.sql, content, learnerId: ALICE, request: {taskInstanceId: hinted, mode: 'study', request: 'hint', requestKey: randomUUID()}})
    assert.equal(hint.status, 'helped')
    assert.deepEqual((await answer(hinted, 'opt-a', later(100))).schedule, {status: 'not_scheduled', reason: 'assisted_correct'})
  })

  it('leaves a due card without a servable question unchanged and says so', async () => {
    await answerFamily('fam1', 'opt-a')
    content.servable.clear()
    const before = await card()
    const body = await start(later(1))
    assert.equal(body.status, 'none')
    assert.deepEqual(body.status === 'none' && [body.reason, body.unavailableDue], ['no_scheduled_questions', 1])
    assert.deepEqual(await card(), before)
  })

  it('resumes its own session, separately from a Mistakes session', async () => {
    await answerFamily('fam1', 'opt-b')
    const mistakes = await startReviewSession({db: db.sql, content, learnerId: ALICE, now: later(1)})
    const scheduled = await active(later(1))
    assert.equal(mistakes.status, 'active')
    assert.notEqual(mistakes.status === 'active' && mistakes.sessionId, scheduled.sessionId)

    const again = await active(later(1))
    assert.equal(again.resumed, true)
    assert.equal(again.sessionId, scheduled.sessionId)
    const mistakesAgain = await startReviewSession({db: db.sql, content, learnerId: ALICE, now: later(1)})
    assert.deepEqual(mistakesAgain.status === 'active' && [mistakesAgain.resumed, mistakesAgain.sessionId], [true, mistakes.status === 'active' && mistakes.sessionId])
  })

  it('marks an item withdrawn since it was issued as unavailable on resume', async () => {
    await answerFamily('fam1', 'opt-a')
    const session = await active(later(1))
    content.servable.delete(openTask(session, 1).task.item._id)
    const resumed = await active(later(1))
    assert.deepEqual(resumed.items.map((item) => item.state), ['unavailable'])
  })
})
