import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {after, before, beforeEach, describe, it} from 'node:test'

import type {LanguageModel} from 'ai'

import {AiCallError} from '../ai/gateway.ts'
import {asLearner} from '../db/learner-scope.ts'
import {createTestDatabase, SKIP_WITHOUT_DATABASE, type TestDatabase} from '../db/test-db.ts'
import type {ReviewResponse, ReviewSubmitRequest} from './contracts.ts'
import {requestReviewHelp, submitForReview, type ReviewServiceOutcome, type SubmitOptions} from './service.ts'
import {CONCATENATED, FixtureTaskSource, failingReviewModel, makeTask, PARAMETERIZED, reviewModel} from './test-fixtures.ts'

/**
 * The submission review service against a real, migrated Postgres, running
 * as the RLS-bound learner role. Models and published content are fixtures.
 */

const ALICE = 'user_alice'
const BOB = 'user_bob'
const LESSON = 'lesson-sql'
const TASK = 'sql-user-lookup'
const FAMILY = `submission-task:${TASK}`
const key = () => randomUUID()
const silent = () => {}

const FIXED = [
  'async function findUserByUsername(db, username) {',
  "  const { rows } = await db.query('SELECT * FROM users WHERE username = $1', [username])",
  '  return rows.length > 0 ? rows[0] : null',
  '}',
].join('\n')

function ok(outcome: ReviewServiceOutcome): ReviewResponse & {wasReplayed: boolean} {
  assert.equal(outcome.status, 'ok', outcome.status === 'rejected' ? outcome.code : '')
  return outcome.status === 'ok' ? {...outcome.body, wasReplayed: outcome.replayed} : (null as never)
}

function code(outcome: ReviewServiceOutcome): string {
  assert.equal(outcome.status, 'rejected')
  return outcome.status === 'rejected' ? outcome.code : ''
}

describe('submission review service', {skip: SKIP_WITHOUT_DATABASE}, () => {
  let db: TestDatabase
  let source: FixtureTaskSource
  let model: ReturnType<typeof reviewModel>

  before(async () => {
    db = await createTestDatabase()
  })
  after(() => db?.drop())

  beforeEach(async () => {
    // Only the tables these tests write, plus `tutor_request` (it references `help_event`), so sibling tables that reference
    // `attempt_log` or `task_instance` never block the truncate once branches are merged.
    await db.sql`truncate learner.submission_log, learner.submission_review, learner.tutor_request, learner.event_outbox, learner.help_event, learner.concept_mastery`
    source = new FixtureTaskSource()
    model = reviewModel()
  })

  const request = (content: string, overrides: Partial<ReviewSubmitRequest> = {}): ReviewSubmitRequest => ({
    action: 'review',
    lessonId: LESSON,
    taskId: TASK,
    taskVersion: 1,
    submission: {type: 'snippet', content},
    requestKey: key(),
    ...overrides,
  })

  const submit = (learnerId: string, content: string, options: Partial<Omit<SubmitOptions, 'request'>> & {request?: Partial<ReviewSubmitRequest>} = {}) =>
    submitForReview({db: db.sql, source, model, learnerId, log: silent, ...options, request: request(content, options.request)})

  const help = (learnerId: string, reviewId: string, kind: 'escalate' | 'solution', requestKey = key()) =>
    requestReviewHelp({db: db.sql, source, learnerId, request: {action: 'help', reviewId, request: kind, requestKey}})

  const counts = async () => {
    const [row] = await db.sql<{reviews: number; logs: number; help: number; mastery: number; outbox: number}[]>`
      select
        (select count(*)::int from learner.submission_review) as reviews,
        (select count(*)::int from learner.submission_log) as logs,
        (select count(*)::int from learner.help_event) as help,
        (select count(*)::int from learner.concept_mastery) as mastery,
        (select count(*)::int from learner.event_outbox) as outbox
    `
    return row
  }

  it('reviews code, discloses level 1, and records the log, help, and text-free outbox events', async () => {
    const body = ok(await submit(ALICE, CONCATENATED))
    assert.equal(body.outcome, 'changes_suggested')
    assert.deepEqual(body.criteria.map((criterion) => criterion.status), ['not_met', 'unclear', 'met'])
    assert.deepEqual([body.help.level, body.help.reasonCode], [1, 'first_help'])
    const [finding] = body.findings
    assert.deepEqual(finding.lines, {start: 2, end: 2})
    assert.ok(finding.question && finding.citations.length > 0)
    assert.deepEqual([finding.explanation, finding.correction, finding.concepts], [undefined, undefined, []])
    assert.deepEqual(body.submission?.evidence, {kind: 'independent', reason: 'first_independent_response'})
    assert.equal(body.submission?.cached, false)
    assert.equal(body.provisional, true)

    const [event] = await db.sql`select session_id, family_id, concept_ids, level, task_instance_id from learner.help_event`
    assert.deepEqual([event.session_id, event.family_id, event.concept_ids, event.level, event.task_instance_id], [`submission-review:${body.reviewId}`, FAMILY, ['cpt-parameterized-queries'], 1, null])

    const outbox = await db.sql<{event_type: string; payload: Record<string, unknown>}[]>`select event_type, payload from learner.event_outbox order by created_at`
    assert.deepEqual(outbox.map((row) => row.event_type).toSorted(), ['help_level_decided', 'submission_reviewed'])
    for (const row of outbox) {
      const text = JSON.stringify(row.payload)
      assert.equal(row.payload.learnerId, ALICE)
      for (const fragment of ['SELECT', 'username', 'glued', 'quote']) assert.ok(!text.includes(fragment), `${row.event_type} leaks "${fragment}"`)
    }
    assert.deepEqual(await counts(), {reviews: 1, logs: 1, help: 1, mastery: 0, outbox: 2})
  })

  it('never stores the submitted code, only its hash', async () => {
    ok(await submit(ALICE, CONCATENATED))
    const tables = await db.sql<{row: string}[]>`
      select row_to_json(r)::text as row from learner.submission_review r
      union all select row_to_json(l)::text from learner.submission_log l
      union all select row_to_json(h)::text from learner.help_event h
    `
    assert.ok(tables.length >= 3)
    for (const {row} of tables) {
      assert.ok(!row.includes('+ username +'), 'the concatenated line is not stored')
      assert.ok(!row.includes('async function findUserByUsername'), 'the submission is not stored')
    }
  })

  it('replays a retried request without recording or calling the model again', async () => {
    const requestKey = key()
    const first = ok(await submit(ALICE, CONCATENATED, {request: {requestKey}}))
    const again = ok(await submit(ALICE, CONCATENATED, {request: {requestKey}}))
    assert.equal(again.wasReplayed, true)
    assert.deepEqual({...again, replayed: false, wasReplayed: false}, {...first, wasReplayed: false})
    assert.deepEqual([model.reviewCalls, model.checkCalls], [1, 1])
    assert.deepEqual(await counts(), {reviews: 1, logs: 1, help: 1, mastery: 0, outbox: 2})
  })

  it('rejects a different body under a used key', async () => {
    const requestKey = key()
    ok(await submit(ALICE, CONCATENATED, {request: {requestKey}}))
    assert.equal(code(await submit(ALICE, PARAMETERIZED, {request: {requestKey}})), 'idempotency_key_reused')
  })

  it('reuses the analysis for unchanged code without escalating, and three identical submissions are one independent attempt', async () => {
    const first = ok(await submit(ALICE, CONCATENATED))
    const second = ok(await submit(ALICE, CONCATENATED))
    const third = ok(await submit(ALICE, `${CONCATENATED}\n\n`))
    assert.deepEqual([model.reviewCalls, model.checkCalls], [1, 1])
    for (const repeat of [second, third]) {
      assert.equal(repeat.reviewId, first.reviewId)
      assert.equal(repeat.submission?.cached, true)
      assert.deepEqual(repeat.submission?.evidence, {kind: 'not_counted', reason: 'repeat_submission'})
      assert.deepEqual([repeat.help.level, repeat.help.reasonCode], [1, 'repeat_current'])
    }
    const kinds = await db.sql<{kind: string}[]>`select evidence_kind as kind from learner.submission_log order by created_at`
    assert.deepEqual(kinds.map((row) => row.kind), ['independent', 'not_counted', 'not_counted'])
  })

  it('never shares a review across learners', async () => {
    const alice = ok(await submit(ALICE, CONCATENATED))
    const bob = ok(await submit(BOB, CONCATENATED))
    assert.notEqual(bob.reviewId, alice.reviewId)
    assert.equal(bob.submission?.cached, false)
    assert.equal(model.reviewCalls, 2)
    assert.deepEqual(bob.submission?.evidence, {kind: 'independent', reason: 'first_independent_response'})

    assert.equal(code(await help(BOB, alice.reviewId, 'solution')), 'not_found')
    const seen = await asLearner(db.sql, BOB, (tx) => tx<{learner_id: string}[]>`select learner_id from learner.submission_review union all select learner_id from learner.submission_log`)
    assert.deepEqual([...new Set(seen.map((row) => row.learner_id))], [BOB])
    const updated = await asLearner(db.sql, BOB, (tx) => tx`update learner.submission_review set status = 'failed' where id = ${alice.reviewId} returning 1`)
    assert.equal(updated.length, 0)
    const [aliceRow] = await db.sql`select status from learner.submission_review where id = ${alice.reviewId}`
    assert.equal(aliceRow.status, 'completed')
  })

  it("cannot write another learner's review or log", async () => {
    await assert.rejects(
      asLearner(db.sql, ALICE, (tx) => tx`
        insert into learner.submission_review
          (learner_id, cache_key, task_id, task_version, task_hash, lesson_id, content_hash, line_count, prompt_version, check_version, model_id, status, claim_token)
        values (${BOB}, ${'a'.repeat(64)}, 't', 1, ${'b'.repeat(64)}, 'l', ${'c'.repeat(64)}, 1, 'p', 'c', 'm', 'pending', ${randomUUID()})
      `),
      (error: {code?: string}) => error.code === '42501',
    )
    await assert.rejects(asLearner(db.sql, ALICE, (tx) => tx`delete from learner.submission_log`), (error: {code?: string}) => error.code === '42501')
  })

  it('escalates only on request: explain (1→2), then corrections (→3), with replays that never escalate', async () => {
    const review = ok(await submit(ALICE, CONCATENATED))
    const requestKey = key()
    const explained = ok(await help(ALICE, review.reviewId, 'escalate', requestKey))
    assert.deepEqual([explained.help.level, explained.help.reasonCode, explained.submission], [2, 'escalation', null])
    assert.ok(explained.findings[0].explanation)
    assert.equal(explained.findings[0].correction, undefined)
    assert.equal(explained.findings[0].concepts[0].name, 'Parameterized queries')

    const replayed = ok(await help(ALICE, review.reviewId, 'escalate', requestKey))
    assert.deepEqual([replayed.help.level, replayed.wasReplayed], [2, true])

    const corrected = ok(await help(ALICE, review.reviewId, 'solution'))
    assert.deepEqual([corrected.help.level, corrected.help.reasonCode], [3, 'explicit_solution'])
    assert.ok(corrected.findings[0].correction)
    assert.deepEqual([model.reviewCalls, model.checkCalls], [1, 1])

    // Re-reviewing the same code shows the level already reached; it does not climb.
    const again = ok(await submit(ALICE, CONCATENATED))
    assert.deepEqual([again.help.level, again.help.reasonCode], [3, 'repeat_current'])

    const levels = await db.sql<{level: number}[]>`select level from learner.help_event order by created_at`
    assert.deepEqual(levels.map((row) => row.level), [1, 2, 3, 3])
  })

  it('treats "show corrections" straight after the first review as an explicit override, and a fix after it as assisted with answer exposure', async () => {
    const review = ok(await submit(ALICE, CONCATENATED))
    ok(await help(ALICE, review.reviewId, 'solution'))
    const [override] = await db.sql`select explicit_override from learner.help_event where level = 3`
    assert.equal(override.explicit_override, true)

    // New code gets its own ladder from level 1, but it still counts as assisted.
    const different = ok(await submit(ALICE, CONCATENATED.replace('const sql', 'let sql')))
    assert.deepEqual([different.help.level, different.help.reasonCode], [1, 'first_help'])
    assert.deepEqual(different.submission?.evidence, {kind: 'assisted', reason: 'answer_exposed'})
    assert.equal(different.findings[0].correction, undefined)

    const fixed = ok(await submit(ALICE, FIXED))
    assert.equal(fixed.outcome, 'no_issues_found')
    assert.deepEqual(fixed.submission?.evidence, {kind: 'assisted', reason: 'answer_exposed'})
    assert.deepEqual([fixed.help.level, fixed.findings], [0, []])
    assert.equal((await counts()).mastery, 0)
  })

  it('counts a fix after hints as assisted, and a second unassisted attempt as not counted', async () => {
    ok(await submit(ALICE, CONCATENATED))
    assert.deepEqual(ok(await submit(ALICE, FIXED)).submission?.evidence, {kind: 'assisted', reason: 'hint_used'})

    ok(await submit(BOB, PARAMETERIZED))
    assert.deepEqual(ok(await submit(BOB, FIXED)).submission?.evidence, {kind: 'not_counted', reason: 'repeat_task'})
  })

  it('has nothing more to explain on a review without problems', async () => {
    const clean = ok(await submit(ALICE, PARAMETERIZED))
    assert.deepEqual([clean.outcome, clean.help.level, clean.help.helpEventId], ['no_issues_found', 0, null])
    assert.equal(code(await help(ALICE, clean.reviewId, 'escalate')), 'hint_unavailable')
  })

  it('records a review that cannot judge, with no help', async () => {
    model = reviewModel({review: () => ({status: 'cannot_judge', cannotJudgeReason: 'unsupported_language', criteria: [], findings: []})})
    const body = ok(await submit(ALICE, 'def find_user(db, name):\n    return None'))
    assert.deepEqual([body.outcome, body.cannotJudgeReason, body.findings, body.help.level], ['cannot_judge', 'unsupported_language', [], 0])
    assert.deepEqual(await counts(), {reviews: 1, logs: 1, help: 0, mastery: 0, outbox: 1})
  })

  it('re-reviews when the task version, task content, or model changes, and refuses stale requests', async () => {
    const first = ok(await submit(ALICE, CONCATENATED))

    const edited = makeTask({criteria: [...makeTask().criteria.slice(0, 2), {id: 'returns-row-or-null', text: 'Return the row or null.'}]})
    source.tasks.set(LESSON, {status: 'ok', task: edited})
    const afterEdit = ok(await submit(ALICE, CONCATENATED))
    assert.notEqual(afterEdit.reviewId, first.reviewId)
    assert.equal(code(await help(ALICE, first.reviewId, 'escalate')), 'task_unavailable')

    source.tasks.set(LESSON, {status: 'ok', task: makeTask({version: 2})})
    assert.equal(code(await submit(ALICE, CONCATENATED)), 'task_unavailable')
    const v2 = ok(await submit(ALICE, CONCATENATED, {request: {taskVersion: 2}}))
    assert.equal(v2.taskVersion, 2)
    // A new review restarts the ladder; assistance carries across versions.
    assert.deepEqual([v2.help.level, v2.help.reasonCode], [1, 'first_help'])
    assert.equal(v2.submission?.evidence.kind, 'not_counted')

    const otherModel = reviewModel({modelId: 'mock-model-2'})
    const byOtherModel = ok(await submit(ALICE, CONCATENATED, {model: otherModel, request: {taskVersion: 2}}))
    assert.notEqual(byOtherModel.reviewId, v2.reviewId)
    assert.equal(otherModel.reviewCalls, 1)
    assert.equal(model.reviewCalls, 3)
  })

  it('refuses a missing, mismatched, or stale task without recording anything', async () => {
    assert.equal(code(await submit(ALICE, CONCATENATED, {request: {taskId: 'other-task'}})), 'not_found')
    assert.equal(code(await submit(ALICE, CONCATENATED, {request: {lessonId: 'lesson-other'}})), 'not_found')
    source.tasks.set(LESSON, {status: 'stale'})
    assert.equal(code(await submit(ALICE, CONCATENATED)), 'task_unavailable')
    source.fail = true
    await assert.rejects(submit(ALICE, CONCATENATED), (error: Error) => error.name === 'ContentUnavailableError')
    assert.deepEqual(await counts(), {reviews: 0, logs: 0, help: 0, mastery: 0, outbox: 0})
    assert.equal(model.reviewCalls, 0)
  })

  it('validates input before any content or database access', async () => {
    assert.equal(code(await submit(ALICE, ' \n ')), 'invalid_request')
    assert.equal(code(await submit(ALICE, 'a\u0001b')), 'invalid_request')
    assert.equal(code(await submit(ALICE, Array(201).fill('x').join('\n'))), 'payload_too_large')
    assert.equal(code(await submit(ALICE, 'x'.repeat(8001))), 'payload_too_large')
    assert.equal(source.calls, 0)
  })

  it('keeps nothing but a failed claim when the provider fails, and a retry re-evaluates', async () => {
    await assert.rejects(submit(ALICE, CONCATENATED, {model: failingReviewModel()}), AiCallError)
    const [failed] = await db.sql`select status, evaluations from learner.submission_review`
    assert.deepEqual([failed.status, failed.evaluations], ['failed', 1])
    assert.deepEqual(await counts(), {reviews: 1, logs: 0, help: 0, mastery: 0, outbox: 0})

    const retried = ok(await submit(ALICE, CONCATENATED))
    assert.equal(retried.outcome, 'changes_suggested')
    // The failed attempt did not count as an earlier submission.
    assert.deepEqual(retried.submission?.evidence, {kind: 'independent', reason: 'first_independent_response'})
    const [done] = await db.sql`select status, evaluations from learner.submission_review`
    assert.deepEqual([done.status, done.evaluations], ['completed', 2])
  })

  it('treats a missing provider as an outage on a cache miss, and still serves a cache hit', async () => {
    await assert.rejects(submit(ALICE, CONCATENATED, {model: null}), AiCallError)
    assert.equal((await counts()).reviews, 0)
    ok(await submit(ALICE, CONCATENATED))
    const cached = ok(await submit(ALICE, CONCATENATED, {model: model as LanguageModel}))
    assert.equal(cached.submission?.cached, true)
  })

  it('enforces the hourly evaluation budget but never charges a cache hit', async () => {
    ok(await submit(ALICE, CONCATENATED, {requestsPerHour: 1}))
    assert.equal(code(await submit(ALICE, PARAMETERIZED, {requestsPerHour: 1})), 'rate_limited')
    assert.equal(ok(await submit(ALICE, CONCATENATED, {requestsPerHour: 1})).submission?.cached, true)
    ok(await submit(BOB, PARAMETERIZED, {requestsPerHour: 1}))
  })

  it('evaluates identical concurrent submissions once, with the same key or a different one', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    model = reviewModel({gate: () => held})
    const requestKey = key()
    const first = submit(ALICE, CONCATENATED, {request: {requestKey}})
    while (model.reviewCalls === 0) await new Promise((resolve) => setTimeout(resolve, 5))

    assert.equal(code(await submit(ALICE, CONCATENATED, {request: {requestKey}})), 'review_in_progress')
    assert.equal(code(await submit(ALICE, CONCATENATED)), 'review_in_progress')
    release()
    const done = ok(await first)

    const retriedSameKey = ok(await submit(ALICE, CONCATENATED, {request: {requestKey}}))
    assert.deepEqual([retriedSameKey.wasReplayed, retriedSameKey.reviewId], [true, done.reviewId])
    const retriedNewKey = ok(await submit(ALICE, CONCATENATED))
    assert.deepEqual([retriedNewKey.submission?.cached, retriedNewKey.reviewId], [true, done.reviewId])
    assert.deepEqual([model.reviewCalls, model.checkCalls], [1, 1])
    assert.equal((await counts()).logs, 2)
  })

  it('records one submission when the same request races itself', async () => {
    const requestKey = key()
    const results = await Promise.all([submit(ALICE, CONCATENATED, {request: {requestKey}}), submit(ALICE, CONCATENATED, {request: {requestKey}})])
    const statuses = results.map((result) => (result.status === 'ok' ? 'ok' : result.code)).toSorted()
    assert.ok(['ok,review_in_progress', 'ok,ok'].includes(statuses.join(',')), statuses.join(','))
    assert.deepEqual([(await counts()).logs, (await counts()).help, model.reviewCalls], [1, 1, 1])
  })

  it('takes over a claim whose lease expired, and the stale holder cannot overwrite it', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const slow = reviewModel({gate: () => held})
    const stale = submit(ALICE, CONCATENATED, {model: slow, leaseSeconds: 0})
    while (slow.reviewCalls === 0) await new Promise((resolve) => setTimeout(resolve, 5))

    const takeover = ok(await submit(ALICE, CONCATENATED, {leaseSeconds: 0}))
    release()
    // The stale holder's result is not written over the completed review; its request reuses it.
    const late = ok(await stale)
    assert.equal(late.reviewId, takeover.reviewId)
    const [row] = await db.sql`select status, evaluations from learner.submission_review`
    assert.deepEqual([row.status, row.evaluations], ['completed', 2])
  })

  it('refuses a help key already used for other help', async () => {
    const review = ok(await submit(ALICE, CONCATENATED))
    const used = key()
    await db.sql`
      insert into learner.help_event (learner_id, session_id, level, policy_version, reason_code, request_key)
      values (${ALICE}, 'tutor-session-1', 1, 'help-v1', 'first_help', ${used})
    `
    assert.equal(code(await help(ALICE, review.reviewId, 'escalate', used)), 'idempotency_key_reused')
    assert.equal(code(await help(ALICE, randomUUID(), 'escalate')), 'not_found')
  })
})
