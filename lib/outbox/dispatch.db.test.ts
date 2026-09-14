import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {after, before, beforeEach, describe, it} from 'node:test'

import {recentJobRuns} from '../db/job-run.ts'
import {createTestDatabase, SKIP_WITHOUT_DATABASE, type TestDatabase} from '../db/test-db.ts'
import {submitAttempt} from '../learner/attempts.ts'
import {issueTask} from '../learner/task-instances.ts'
import {FixtureContent} from '../learner/test-content.ts'
import {dispatchOutbox, type DispatchOptions} from './dispatch.ts'
import {SinkError, type Sink} from './posthog-sink.ts'
import type {CaptureEvent} from './projection.ts'
import {outboxStatus, requeueFailed} from './status.ts'

/**
 * The outbox dispatcher against a real Postgres (development plan §5 PR-10):
 * concurrent workers, abandoned claims, a send accepted by PostHog whose
 * local record then fails, backoff and dead-lettering, synthetic learners,
 * and grading while analytics is down. The sink is an in-memory fake.
 */

const ALICE = 'user_alice'
const BOB = 'user_bob'

type Row = {id: string; status: string; attempts: number; last_error: string | null; claimed_by: string | null}

class FakeSink implements Sink {
  sent: CaptureEvent[][] = []
  failWith: SinkError | null = null
  delayMs = 0
  async send(events: CaptureEvent[]) {
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs))
    if (this.failWith) throw this.failWith
    this.sent.push(events.map((event) => structuredClone(event)))
  }
  get uuids() {
    return this.sent.flat().map((event) => event.uuid)
  }
}

const attemptPayload = (learnerId: string) => ({
  attemptId: randomUUID(),
  learnerId,
  assessmentId: 'assessment-fam1-v1',
  familyId: 'fam1',
  assessmentVersion: 1,
  conceptId: 'cpt-state',
  correct: true,
  evidenceKind: 'independent',
  evidenceReason: 'first_independent_response',
  policyVersion: 'evidence-v1',
})

describe('outbox dispatcher', {skip: SKIP_WITHOUT_DATABASE}, () => {
  let db: TestDatabase

  before(async () => {
    db = await createTestDatabase()
  })
  after(() => db?.drop())

  beforeEach(async () => {
    await db.sql`truncate learner.event_outbox, learner.synthetic_learner, editorial.job_run, learner.concept_mastery, learner.help_event, learner.attempt_log, learner.task_instance, learner.tutor_request`
  })

  /** Inserts outbox rows as the superuser, one second apart so their order is stable. */
  async function seed(count: number, learnerId = ALICE, eventType = 'attempt_graded', payload?: Record<string, unknown>) {
    const ids: string[] = []
    for (let index = 0; index < count; index++) {
      const [row] = await db.sql<{id: string}[]>`
        insert into learner.event_outbox (event_type, payload, created_at)
        values (${eventType}, ${db.sql.json((payload ?? attemptPayload(learnerId)) as never)}, now() - make_interval(secs => ${1000 - index}))
        returning id
      `
      ids.push(row.id)
    }
    return ids
  }

  const rows = () =>
    db.sql<Row[]>`select id, status, attempts, last_error, claimed_by from learner.event_outbox order by created_at`

  const run = (sink: Sink, options: Partial<DispatchOptions> = {}) =>
    dispatchOutbox({db: db.sql, sink, workerId: options.workerId ?? `test-${randomUUID()}`, ...options})

  it('delivers pending rows in order with the row id as the event uuid', async () => {
    const ids = await seed(5)
    const sink = new FakeSink()
    const summary = await run(sink, {batchSize: 2})
    assert.equal(summary.delivered, 5)
    assert.equal(summary.batches, 3)
    assert.deepEqual(sink.uuids, ids)
    for (const row of await rows()) {
      assert.equal(row.status, 'delivered')
      assert.equal(row.attempts, 1)
      assert.equal(row.claimed_by, null)
    }
    // Nothing left: a second run claims nothing.
    assert.equal((await run(sink)).claimed, 0)
  })

  it('never lets concurrent dispatchers claim the same row', async () => {
    const ids = await seed(40)
    const sinks = [new FakeSink(), new FakeSink(), new FakeSink()]
    for (const sink of sinks) sink.delayMs = 20
    const summaries = await Promise.all(sinks.map((sink, index) => run(sink, {batchSize: 5, workerId: `worker-${index}`})))
    const sent = sinks.flatMap((sink) => sink.uuids)
    assert.equal(sent.length, 40, 'no row sent by two concurrent dispatchers')
    assert.deepEqual(sent.toSorted(), ids.toSorted())
    assert.equal(
      summaries.reduce((sum, summary) => sum + summary.delivered, 0),
      40,
    )
    for (const row of await rows()) assert.equal(row.attempts, 1, 'no row claimed twice')
  })

  it('recovers a claim abandoned by a crashed worker once its lease expires', async () => {
    const [id] = await seed(1)
    await db.sql`update learner.event_outbox set claimed_by = 'crashed-worker', claimed_until = now() + interval '1 hour', attempts = 1 where id = ${id}`
    const sink = new FakeSink()
    assert.equal((await run(sink)).claimed, 0, 'a live lease is respected')
    assert.deepEqual((await outboxStatus(db.sql)).inFlight, 1)

    await db.sql`update learner.event_outbox set claimed_until = now() - interval '1 second' where id = ${id}`
    assert.equal((await outboxStatus(db.sql)).abandonedClaims, 1)
    const summary = await run(sink)
    assert.equal(summary.delivered, 1)
    const [row] = await rows()
    assert.equal(row.status, 'delivered')
    assert.equal(row.attempts, 2, 'the abandoned attempt still counts')
  })

  it('resends with the same uuid and timestamp when PostHog accepted but the local record failed', async () => {
    const [id] = await seed(1)
    await db.sql.unsafe(`
      create function learner.fail_delivered() returns trigger language plpgsql as $$
      begin raise exception 'injected failure recording delivery'; end $$;
      create trigger fail_delivered before update on learner.event_outbox
        for each row when (new.status = 'delivered') execute function learner.fail_delivered();
    `).simple()
    const sink = new FakeSink()
    try {
      await assert.rejects(run(sink, {workerId: 'worker-a', recordRun: true}), /injected failure recording delivery/)
    } finally {
      await db.sql.unsafe('drop trigger fail_delivered on learner.event_outbox; drop function learner.fail_delivered();').simple()
    }
    assert.equal(sink.sent.length, 1, 'PostHog received the event')
    let [row] = await rows()
    assert.equal(row.status, 'pending', 'but it is not recorded as delivered')
    assert.equal(row.claimed_by, 'worker-a', 'and worker-a still holds the lease')

    // Before the lease expires, nothing is resent.
    assert.equal((await run(sink, {workerId: 'worker-b'})).claimed, 0)
    await db.sql`update learner.event_outbox set claimed_until = now() - interval '1 second' where id = ${id}`
    const summary = await run(sink, {workerId: 'worker-b'})
    assert.equal(summary.delivered, 1)
    assert.equal(sink.sent.length, 2, 'at-least-once: sent a second time')
    // PostHog merges duplicates that share uuid, event, timestamp, and distinct_id (eventually, on ClickHouse merges).
    const [[first], [second]] = sink.sent
    assert.deepEqual(
      [second.uuid, second.event, second.timestamp, second.distinct_id],
      [first.uuid, first.event, first.timestamp, first.distinct_id],
      'the resend carries the same deduplication key',
    )
    assert.deepEqual(second, first, 'and is identical in every field')
    ;[row] = await rows()
    assert.equal(row.status, 'delivered')

    const [failedRun] = await recentJobRuns(db.sql, 'outbox_dispatch')
    assert.equal(failedRun.status, 'failed')
    assert.match(failedRun.error ?? '', /injected failure/)
  })

  it('backs off after a failed send and dead-letters at the attempt cap, then requeues', async () => {
    await seed(2)
    const sink = new FakeSink()
    sink.failWith = new SinkError('http_5xx', 503)

    const first = await run(sink, {maxAttempts: 3})
    assert.equal(first.stoppedOn, 'http_5xx')
    assert.equal(first.retried, 2)
    const [backoff] = await db.sql<{seconds: number}[]>`
      select extract(epoch from min(next_attempt_at) - now())::float8 as seconds from learner.event_outbox
    `
    assert.ok(backoff.seconds > 25 && backoff.seconds <= 30, `first backoff ~30 s, got ${backoff.seconds}`)
    assert.equal((await run(sink, {maxAttempts: 3})).claimed, 0, 'not retried before the backoff passes')

    await db.sql`update learner.event_outbox set next_attempt_at = now()`
    await run(sink, {maxAttempts: 3})
    const [second] = await db.sql<{seconds: number}[]>`
      select extract(epoch from min(next_attempt_at) - now())::float8 as seconds from learner.event_outbox
    `
    assert.ok(second.seconds > 55 && second.seconds <= 60, `second backoff ~60 s, got ${second.seconds}`)

    await db.sql`update learner.event_outbox set next_attempt_at = now()`
    const third = await run(sink, {maxAttempts: 3})
    assert.equal(third.deadLettered, 2)
    for (const row of await rows()) {
      assert.equal(row.status, 'failed')
      assert.equal(row.attempts, 3)
      assert.equal(row.last_error, 'http_5xx')
    }
    assert.equal((await outboxStatus(db.sql)).failed.length, 2)

    assert.equal(await requeueFailed(db.sql), 2)
    sink.failWith = null
    assert.equal((await run(sink, {maxAttempts: 3})).delivered, 2)
  })

  it('moves a pending row abandoned at the attempt cap to failed instead of retrying it forever', async () => {
    const [id] = await seed(1)
    await db.sql`update learner.event_outbox set claimed_by = 'crashed', claimed_until = now() - interval '1 second', attempts = 3 where id = ${id}`
    const sink = new FakeSink()
    const summary = await run(sink, {maxAttempts: 3})
    assert.equal(summary.abandonedAtCap, 1)
    assert.equal(sink.sent.length, 0)
    const [row] = await rows()
    assert.deepEqual([row.status, row.last_error], ['failed', 'abandoned_at_attempt_cap'])
  })

  it('suppresses labelled synthetic learners and dead-letters malformed events without sending them', async () => {
    await db.sql`insert into learner.synthetic_learner (learner_id, label) values (${BOB}, 'demo')`
    const [alice] = await seed(1, ALICE)
    await seed(1, BOB)
    await seed(1, ALICE, 'help_level_decided', {learnerId: ALICE, familyId: null, level: 1, reasonCode: 'Free text!', explicitOverride: false, policyVersion: 'help-v1'})

    const sink = new FakeSink()
    const summary = await run(sink)
    assert.deepEqual(sink.uuids, [alice])
    assert.equal(summary.suppressed, 1)
    assert.equal(summary.invalid, 1)
    const statuses = (await rows()).map((row) => [row.status, row.last_error])
    assert.deepEqual(statuses, [
      ['delivered', null],
      ['suppressed', 'synthetic_learner'],
      ['failed', 'invalid_payload'],
    ])
    assert.equal(JSON.stringify(sink.sent).includes(BOB), false)
  })

  it('holds an event type without an approved projection: never claimed, sent, dead-lettered, or marked delivered', async () => {
    const [held] = await seed(1, ALICE, 'explanation_checked', {learnerId: ALICE, explanationId: randomUUID()})
    const [alice] = await seed(1, ALICE)
    const sink = new FakeSink()
    const summary = await run(sink, {maxAttempts: 3})
    assert.deepEqual(sink.uuids, [alice])
    assert.equal(summary.claimed, 1)

    const [row] = await db.sql<Row[]>`select id, status, attempts, last_error, claimed_by from learner.event_outbox where id = ${held}`
    assert.deepEqual([row.status, row.attempts, row.last_error, row.claimed_by], ['pending', 0, null, null])
    const status = await outboxStatus(db.sql)
    assert.equal(status.held.length, 1)
    assert.deepEqual([status.held[0].eventType, status.held[0].count], ['explanation_checked', 1])
    assert.equal(status.dueNow, 0, 'held rows are not counted as due')

    // Even a held row that somehow reached the attempt cap is not swept into failed.
    await db.sql`update learner.event_outbox set attempts = 3 where id = ${held}`
    assert.equal((await run(sink, {maxAttempts: 3})).abandonedAtCap, 0)
    const [after] = await db.sql<Row[]>`select id, status, attempts, last_error, claimed_by from learner.event_outbox where id = ${held}`
    assert.equal(after.status, 'pending')
  })

  it("delivers PR-12's submission_reviewed with only its allowlisted fields", async () => {
    const [id] = await seed(1, ALICE, 'submission_reviewed', {
      submissionId: randomUUID(),
      learnerId: ALICE,
      reviewId: randomUUID(),
      taskId: 'hash-a-password',
      taskVersion: 1,
      lessonId: 'lesson-abc123',
      outcome: 'no_issues_found',
      findings: {defect: 0, requirement_mismatch: 0, alternative_valid: 1, uncertain: 0},
      droppedFindings: 0,
      cacheHit: true,
      evidenceKind: 'independent',
      evidenceReason: 'first_independent_response',
      helpLevel: 0,
      helpEventId: null,
      promptVersion: 'review-v3',
      checkVersion: 'review-check-v2',
    })
    const sink = new FakeSink()
    assert.equal((await run(sink)).delivered, 1)
    assert.deepEqual(sink.uuids, [id])
    const [[event]] = sink.sent
    assert.equal(event.event, 'submission_reviewed')
    assert.equal(event.properties.outcome, 'no_issues_found')
    assert.equal(/submission_id|review_id|help_event_id/.test(Object.keys(event.properties).join()), false)
  })

  it('keeps grading and evidence independent of analytics availability', async () => {
    const content = new FixtureContent()
    content.concepts.set('concept-cpt-state', {id: 'concept-cpt-state', conceptId: 'cpt-state', reviewStatus: 'approved'})
    content.addItem('fam1')
    const now = new Date()
    const issued = await issueTask({db: db.sql, content, learnerId: ALICE, assessmentId: 'assessment-fam1-v1', now})
    assert.equal(issued.status, 'issued')
    const taskInstanceId = issued.status === 'issued' ? issued.body.taskInstanceId : ''

    // PostHog is down before, during, and after the submission.
    const sink = new FakeSink()
    sink.failWith = new SinkError('network', null)
    await run(sink)
    const graded = await submitAttempt({
      db: db.sql,
      content,
      learnerId: ALICE,
      request: {taskInstanceId, optionId: 'opt-a', idempotencyKey: `key-${randomUUID().replaceAll('-', '')}`},
      now,
    })
    assert.equal(graded.status, 'graded')
    assert.equal((await run(sink)).retried, 1)

    const [state] = await db.sql<{attempts: number; mastery: number}[]>`
      select (select count(*)::int from learner.attempt_log) as attempts, (select count(*)::int from learner.concept_mastery) as mastery
    `
    assert.deepEqual(state, {attempts: 1, mastery: 1})

    // Once PostHog is back, the real event goes out with only allowlisted fields.
    sink.failWith = null
    await db.sql`update learner.event_outbox set next_attempt_at = now()`
    assert.equal((await run(sink)).delivered, 1)
    const [event] = sink.sent.flat()
    assert.equal(event.distinct_id, ALICE)
    assert.equal(JSON.stringify(event.properties).includes(ALICE), false)
    assert.equal('attempt_id' in event.properties, false)
  })
})
