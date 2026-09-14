import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {after, before, beforeEach, describe, it} from 'node:test'

import {asLearner} from '../db/learner-scope.ts'
import {createTestDatabase, SKIP_WITHOUT_DATABASE, type TestDatabase} from '../db/test-db.ts'
import {submitAttempt} from '../learner/attempts.ts'
import {requestHelp} from '../learner/help.ts'
import {issueTask} from '../learner/task-instances.ts'
import {FixtureContent} from '../learner/test-content.ts'

/**
 * Scheduled-review cards against the real schema, as the web app's RLS-bound
 * role (prompts/pr-9-scheduled-review.md): every graded answer with an active
 * concept reaches the learner's card for its concept and item type in the
 * attempt's own transaction; unassisted answers are rated Good or Again,
 * assisted correct ones are logged unrated and change nothing; replays,
 * concurrency, failures, other learners, and the flag being off all leave
 * the schedule consistent.
 */

const ALICE = 'user_alice'
const BOB = 'user_bob'
const NOW = new Date('2026-09-14T09:00:00.000Z')
const MINUTE = 60 * 1000

type CardSnapshot = {conceptId: string; taskType: string; state: number; reps: number; lapses: number; due: Date; stability: number}
type LogRow = {outcome: string; rating: number | null; previous: {reps: number}; next: {reps: number; due: string}}

describe('scheduled-review cards', {skip: SKIP_WITHOUT_DATABASE}, () => {
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
    content.addItem('fam1')
    content.addItem('fam2')
    content.addItem('fam3', {type: 'recall'})
    content.addItem('orphan', {concept: null})
  })

  async function issue(learnerId: string, familyId: string, now = NOW): Promise<string> {
    const outcome = await issueTask({db: db.sql, content, learnerId, assessmentId: `assessment-${familyId}-v1`, now})
    assert.equal(outcome.status, 'issued')
    return outcome.status === 'issued' ? outcome.body.taskInstanceId : ''
  }

  function submit(
    learnerId: string,
    taskInstanceId: string,
    optionId: string,
    {scheduling = true, now = NOW, selfConfidence, idempotencyKey = randomUUID()}: {scheduling?: boolean; now?: Date; selfConfidence?: number; idempotencyKey?: string} = {},
  ) {
    return submitAttempt({
      db: db.sql,
      content,
      learnerId,
      request: {taskInstanceId, optionId, idempotencyKey, ...(selfConfidence ? {selfConfidence} : {})},
      now,
      scheduling,
    })
  }

  async function graded(...args: Parameters<typeof submit>) {
    const outcome = await submit(...args)
    assert.equal(outcome.status, 'graded', JSON.stringify(outcome))
    return outcome.status === 'graded' ? outcome.body : assert.fail()
  }

  async function hint(learnerId: string, taskInstanceId: string, request: 'hint' | 'solution' = 'hint') {
    const outcome = await requestHelp({db: db.sql, content, learnerId, request: {taskInstanceId, mode: 'study', request, requestKey: randomUUID()}})
    assert.equal(outcome.status, 'helped', JSON.stringify(outcome))
  }

  const cards = async (learnerId = ALICE) => [
    ...(await db.sql<CardSnapshot[]>`
      select concept_id as "conceptId", task_type as "taskType", state, reps, lapses, due, stability
      from learner.review_card where learner_id = ${learnerId} order by task_type
    `),
  ]
  const logs = (learnerId = ALICE) => db.sql<LogRow[]>`
    select outcome, rating, previous_state as previous, new_state as next
    from learner.review_log where learner_id = ${learnerId}
    -- created_at is the transaction start, so it cannot order concurrent answers; the card's reps can.
    order by (new_state->>'reps')::int, created_at
  `

  it('rates an unassisted correct first answer Good on the concept-and-type card', async () => {
    const body = await graded(ALICE, await issue(ALICE, 'fam1'), 'opt-a')
    assert.deepEqual(body.schedule, {status: 'scheduled', dueAt: new Date(NOW.getTime() + 10 * MINUTE).toISOString()})
    const [card] = await cards()
    assert.deepEqual([card.conceptId, card.taskType, card.state, card.reps], ['cpt-state', 'apply', 1, 1])
    assert.deepEqual((await logs()).map((log) => [log.outcome, log.rating]), [['rated', 3]])
  })

  it('rates a miss Again, with or without help', async () => {
    await graded(ALICE, await issue(ALICE, 'fam1'), 'opt-b')
    const helped = await issue(ALICE, 'fam3')
    await hint(ALICE, helped)
    await graded(ALICE, helped, 'opt-b')
    assert.deepEqual((await logs()).map((log) => [log.outcome, log.rating]), [
      ['rated', 1],
      ['rated', 1],
    ])
  })

  it('never rates an assisted correct answer: a new card stays New, an existing one unchanged', async () => {
    const first = await issue(ALICE, 'fam1')
    await hint(ALICE, first)
    const body = await graded(ALICE, first, 'opt-a')
    assert.deepEqual(body.schedule, {status: 'not_scheduled', reason: 'assisted_correct'})
    const [created] = await cards()
    assert.deepEqual([created.state, created.reps, created.due.toISOString()], [0, 0, NOW.toISOString()])

    // Rate the card once, then an assisted correct answer on another family must not move it.
    await graded(ALICE, await issue(ALICE, 'fam2'), 'opt-a')
    const [rated] = await cards()
    const exposed = await issue(ALICE, 'fam1', new Date(NOW.getTime() + MINUTE))
    // fam1 is a repeat now; its own task gets the solution before the answer.
    await hint(ALICE, exposed, 'solution')
    await graded(ALICE, exposed, 'opt-a', {now: new Date(NOW.getTime() + MINUTE)})
    assert.deepEqual(await cards(), [rated])
    assert.deepEqual((await logs()).map((log) => [log.outcome, log.rating]), [
      ['unrated_assisted_correct', null],
      ['rated', 3],
      ['unrated_assisted_correct', null],
    ])
    const last = (await logs())[2]
    assert.deepEqual(last.previous, last.next)
  })

  it('ignores self-confidence entirely', async () => {
    await graded(ALICE, await issue(ALICE, 'fam1'), 'opt-a', {selfConfidence: 1})
    await graded(BOB, await issue(BOB, 'fam1'), 'opt-a', {selfConfidence: 5})
    const [alice] = await cards(ALICE)
    const [bob] = await cards(BOB)
    assert.deepEqual(alice, bob)
  })

  it('writes nothing with the flag off, and an answer without a concept reaches no card', async () => {
    const body = await graded(ALICE, await issue(ALICE, 'fam1'), 'opt-a', {scheduling: false})
    assert.equal('schedule' in body, false)
    const orphan = await graded(ALICE, await issue(ALICE, 'orphan'), 'opt-a')
    assert.equal('schedule' in orphan, false)
    assert.deepEqual([(await cards()).length, (await logs()).length], [0, 0])
  })

  it('returns the recorded schedule on a replay and logs the answer once', async () => {
    const task = await issue(ALICE, 'fam1')
    const idempotencyKey = randomUUID()
    const first = await graded(ALICE, task, 'opt-a', {idempotencyKey})
    const replay = await submit(ALICE, task, 'opt-a', {idempotencyKey})
    assert.equal(replay.status, 'graded')
    assert.deepEqual(replay.status === 'graded' && replay.body, first)
    assert.equal(replay.status === 'graded' && replay.replayed, true)
    assert.equal((await logs()).length, 1)
  })

  it('applies concurrent answers on two families of one card in order', async () => {
    const [a, b] = [await issue(ALICE, 'fam1'), await issue(ALICE, 'fam2')]
    const results = await Promise.all([graded(ALICE, a, 'opt-a'), graded(ALICE, b, 'opt-a')])
    assert.ok(results.every((result) => result.schedule?.status === 'scheduled'))
    const [card] = await cards()
    assert.equal(card.reps, 2)
    const [first, second] = await logs()
    assert.deepEqual([first.previous.reps, first.next.reps, second.previous.reps, second.next.reps], [0, 1, 1, 2])
  })

  it('rolls the attempt back with the card when the log write fails', async () => {
    await db.sql.unsafe(`
      create function learner.test_fail_review_log() returns trigger language plpgsql as $$ begin raise exception 'boom'; end $$;
      create trigger test_fail_review_log before insert on learner.review_log for each row execute function learner.test_fail_review_log();
    `)
    try {
      await assert.rejects(submit(ALICE, await issue(ALICE, 'fam1'), 'opt-a'))
      const [counts] = await db.sql<{attempts: number; cards: number; mastery: number}[]>`
        select (select count(*)::int from learner.attempt_log) as attempts,
               (select count(*)::int from learner.review_card) as cards,
               (select count(*)::int from learner.concept_mastery) as mastery
      `
      assert.deepEqual(counts, {attempts: 0, cards: 0, mastery: 0})
    } finally {
      await db.sql.unsafe(`
        drop trigger test_fail_review_log on learner.review_log;
        drop function learner.test_fail_review_log();
      `)
    }
  })

  it('keeps each learner’s cards and logs private under row level security', async () => {
    await graded(ALICE, await issue(ALICE, 'fam1'), 'opt-a')
    const seen = await asLearner(db.sql, BOB, async (tx) => {
      const [row] = await tx<{cards: number; logs: number}[]>`
        select (select count(*)::int from learner.review_card) as cards, (select count(*)::int from learner.review_log) as logs
      `
      const updated = await tx`update learner.review_card set due = now() where learner_id = ${ALICE}`
      return {...row, updated: updated.count}
    })
    assert.deepEqual(seen, {cards: 0, logs: 0, updated: 0})
    await assert.rejects(
      asLearner(db.sql, BOB, (tx) => tx`
        insert into learner.review_card
          (learner_id, concept_id, task_type, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps,
           reps, lapses, state, algorithm_version, params_version, rating_policy_version)
        values (${ALICE}, 'cpt-state', 'recall', now(), 0, 0, 0, 0, 0, 0, 0, 0, 'x', 'x', 'x')
      `),
    )
    await assert.rejects(asLearner(db.sql, ALICE, (tx) => tx`delete from learner.review_log`))
  })
})
