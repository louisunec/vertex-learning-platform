import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {after, before, beforeEach, describe, it} from 'node:test'

import {EXPLAIN_PROMPT_VERSION, EXPLAIN_VALIDATOR_VERSION} from '../ai/explain.ts'
import {AiCallError} from '../ai/gateway.ts'
import {asLearner} from '../db/learner-scope.ts'
import {createTestDatabase, SKIP_WITHOUT_DATABASE, type TestDatabase} from '../db/test-db.ts'
import {ContentUnavailableError} from '../learner/content-source.ts'
import type {ExplainRequest, ExplainResponse} from './contracts.ts'
import {submitExplanation, type ExplainServiceOutcome, type SubmitExplanationOptions} from './service.ts'
import {
  ACCURATE,
  defaultExplain,
  explainModel,
  failingExplainModel,
  FixtureTaskSource,
  makeTask,
  REVERSED,
  RISE_ONLY,
  FIXTURE_EVIDENCE,
  FIXTURE_LESSON,
} from './test-fixtures.ts'

/**
 * The explain-back service against a real, migrated Postgres, running as the
 * RLS-bound learner role. Models and published content are fixtures.
 */

const ALICE = 'user_alice'
const BOB = 'user_bob'
const TASK = 'dough-rise-and-set'
const key = () => randomUUID()
const silent = () => {}

const OFF_TOPIC = 'Flexbox shares the leftover space along the main axis between the items.'

function ok(outcome: ExplainServiceOutcome): ExplainResponse & {wasReplayed: boolean} {
  assert.equal(outcome.status, 'ok', outcome.status === 'rejected' ? outcome.code : '')
  return outcome.status === 'ok' ? {...outcome.body, wasReplayed: outcome.replayed} : (null as never)
}

function code(outcome: ExplainServiceOutcome): string {
  assert.equal(outcome.status, 'rejected')
  return outcome.status === 'rejected' ? outcome.code : ''
}

const evidence = (body: ExplainResponse) => `${body.attempt.evidence.kind}/${body.attempt.evidence.reason}`

describe('explain-back service', {skip: SKIP_WITHOUT_DATABASE}, () => {
  let db: TestDatabase
  let source: FixtureTaskSource
  let model: ReturnType<typeof explainModel>

  before(async () => {
    db = await createTestDatabase()
  })
  after(() => db?.drop())

  beforeEach(async () => {
    // `cascade`: tables from sibling branches that reference these never block the truncate once merged.
    await db.sql`
      truncate learner.explanation_log, learner.tutor_request, learner.event_outbox, learner.help_event,
        learner.attempt_log, learner.task_instance, learner.concept_mastery cascade
    `
    source = new FixtureTaskSource()
    model = explainModel()
  })

  const request = (text: string, overrides: Partial<ExplainRequest> = {}): ExplainRequest => ({
    lessonId: FIXTURE_LESSON.id,
    taskId: TASK,
    taskVersion: 1,
    text,
    idempotencyKey: key(),
    ...overrides,
  })

  const submit = (learnerId: string, text: string, options: Partial<Omit<SubmitExplanationOptions, 'request'>> & {request?: Partial<ExplainRequest>} = {}) =>
    submitExplanation({db: db.sql, source, model, learnerId, log: silent, ...options, request: request(text, options.request)})

  const counts = async () => {
    const [row] = await db.sql<{explanations: number; mastery: number; outbox: number; help: number}[]>`
      select
        (select count(*)::int from learner.explanation_log) as explanations,
        (select count(*)::int from learner.concept_mastery) as mastery,
        (select count(*)::int from learner.event_outbox) as outbox,
        (select count(*)::int from learner.help_event) as help
    `
    return row
  }

  it('gives criterion-level feedback and records versions, provenance, and a text-free outbox event', async () => {
    const body = ok(await submit(ALICE, RISE_ONLY))
    assert.equal(body.outcome, 'assessed')
    assert.deepEqual(body.criteria.map((criterion) => [criterion.criterionId, criterion.status]), [
      ['c-rise', 'demonstrated'],
      ['c-set', 'missing'],
      ['c-salt', 'missing'],
    ])
    assert.equal(RISE_ONLY.slice(body.criteria[0].span!.start, body.criteria[0].span!.end), RISE_ONLY)
    assert.ok(body.criteria[1].citations.every((citation) => citation.href.startsWith('/lessons/why-dough-rises?t=')))
    assert.ok(body.followUpQuestion?.endsWith('?'))
    assert.deepEqual(body.attempt, {number: 1, revisionOf: null, cached: false, evidence: {kind: 'independent', reason: 'first_independent_response'}})
    assert.equal(body.provisional, true)
    assert.ok(!JSON.stringify(body).includes(makeTask().criteria[1].point), 'the private rubric is never returned')

    const task = makeTask()
    const [row] = await db.sql`
      select learner_id, response, evaluation_status, task_id, task_version, lesson_id, rubric_version, task_hash, source_refs,
             concept_ids, prompt_version, validator_version, model_version, cache_hit, attempt_number, feedback_exposed,
             help_level_before, evidence_kind, evidence_reason, char_count, outcome
      from learner.explanation_log
    `
    assert.deepEqual(
      {...row, source_refs: undefined},
      {
        learner_id: ALICE,
        response: RISE_ONLY,
        evaluation_status: 'evaluated',
        task_id: TASK,
        task_version: '1',
        lesson_id: FIXTURE_LESSON.id,
        rubric_version: task.rubricHash,
        task_hash: task.taskHash,
        source_refs: undefined,
        concept_ids: ['cpt-dough-fermentation', 'cpt-oven-spring'],
        prompt_version: EXPLAIN_PROMPT_VERSION,
        validator_version: EXPLAIN_VALIDATOR_VERSION,
        model_version: 'mock-model-id',
        cache_hit: false,
        attempt_number: 1,
        feedback_exposed: false,
        help_level_before: 0,
        evidence_kind: 'independent',
        evidence_reason: 'first_independent_response',
        char_count: RISE_ONLY.length,
        outcome: 'assessed',
      },
    )
    assert.deepEqual(row.source_refs, FIXTURE_EVIDENCE.map(({chunkId, chunkRevision}) => ({chunkId, chunkRevision})))

    const [event] = await db.sql<{event_type: string; payload: Record<string, unknown>}[]>`select event_type, payload from learner.event_outbox`
    assert.equal(event.event_type, 'explanation_evaluated')
    assert.equal(event.payload.learnerId, ALICE)
    assert.deepEqual(event.payload.required, {demonstrated: 1, missing: 1, unclear: 0, contradicted: 0, insufficient_evidence: 0, not_validated: 0})
    // The contract PR-10's analytics projection reads (ids, enums, counts, versions); a new key needs its projection updated.
    assert.deepEqual(Object.keys(event.payload).toSorted(), [
      'adjustedByServer',
      'attemptNumber',
      'cacheHit',
      'evaluationStatus',
      'evidenceKind',
      'evidenceReason',
      'explanationId',
      'feedbackExposed',
      'helpLevelBefore',
      'learnerId',
      'lessonId',
      'modelId',
      'optional',
      'outcome',
      'promptVersion',
      'required',
      'revisionOf',
      'taskId',
      'taskVersion',
      'validatorVersion',
    ])
    const payload = JSON.stringify(event.payload)
    for (const fragment of ['yeast feeds', 'gives off gas', 'Think about', 'rise while it proofs', '?']) assert.ok(!payload.includes(fragment), `outbox leaks "${fragment}"`)
    assert.deepEqual(await counts(), {explanations: 1, mastery: 0, outbox: 1, help: 0})
  })

  it("keeps each learner's explanations invisible to every other learner", async () => {
    ok(await submit(ALICE, RISE_ONLY))
    const seen = await asLearner(db.sql, BOB, (tx) => tx`select response from learner.explanation_log`)
    assert.equal(seen.length, 0)
    const own = await asLearner(db.sql, ALICE, (tx) => tx`select response from learner.explanation_log`)
    assert.equal(own.length, 1)
  })

  it('replays a retried request without recording or calling the model again', async () => {
    const idempotencyKey = key()
    const first = ok(await submit(ALICE, RISE_ONLY, {request: {idempotencyKey}}))
    const again = ok(await submit(ALICE, RISE_ONLY, {request: {idempotencyKey}}))
    assert.equal(again.wasReplayed, true)
    assert.deepEqual({...again, replayed: false, wasReplayed: false}, {...first, wasReplayed: false})
    assert.equal(model.calls, 1)
    assert.deepEqual(await counts(), {explanations: 1, mastery: 0, outbox: 1, help: 0})
  })

  it('rejects different text under a used key', async () => {
    const idempotencyKey = key()
    ok(await submit(ALICE, RISE_ONLY, {request: {idempotencyKey}}))
    assert.equal(code(await submit(ALICE, ACCURATE, {request: {idempotencyKey}})), 'idempotency_key_reused')
    assert.equal(model.calls, 1)
  })

  it('lets concurrent retries with one key produce exactly one durable result', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    model = explainModel({gate: () => held})
    const idempotencyKey = key()
    const first = submit(ALICE, RISE_ONLY, {request: {idempotencyKey}})
    while (model.calls === 0) await new Promise((resolve) => setTimeout(resolve, 5))
    const concurrent = await Promise.all([1, 2, 3].map(() => submit(ALICE, RISE_ONLY, {request: {idempotencyKey}})))
    assert.deepEqual(concurrent.map(code), ['explanation_in_progress', 'explanation_in_progress', 'explanation_in_progress'])
    release()
    const body = ok(await first)
    const retried = ok(await submit(ALICE, RISE_ONLY, {request: {idempotencyKey}}))
    assert.deepEqual([retried.wasReplayed, retried.explanationId], [true, body.explanationId])
    assert.equal(model.calls, 1)
    assert.deepEqual(await counts(), {explanations: 1, mastery: 0, outbox: 1, help: 0})
  })

  it('counts identical text sent concurrently under two keys only once as evidence', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    model = explainModel({gate: () => held})
    const both = [submit(ALICE, RISE_ONLY), submit(ALICE, RISE_ONLY)]
    while (model.calls < 2) await new Promise((resolve) => setTimeout(resolve, 5))
    release()
    const bodies = (await Promise.all(both)).map(ok)
    assert.deepEqual(bodies.map(evidence).toSorted(), ['independent/first_independent_response', 'not_counted/repeat_submission'])
    assert.deepEqual(bodies.map((body) => body.attempt.number).toSorted(), [1, 2])
  })

  it("reuses this learner's evaluation of identical text, but never another learner's", async () => {
    const first = ok(await submit(ALICE, RISE_ONLY))
    const repeat = ok(await submit(ALICE, `  ${RISE_ONLY}\r\n`))
    assert.equal(model.calls, 1)
    assert.deepEqual([repeat.attempt.cached, evidence(repeat), repeat.attempt.number], [true, 'not_counted/repeat_submission', 2])
    assert.deepEqual(repeat.criteria, first.criteria)
    const [reused] = await db.sql`select reused_from, cache_hit from learner.explanation_log where id = ${repeat.explanationId}`
    assert.deepEqual([reused.reused_from, reused.cache_hit], [first.explanationId, true])

    const bob = ok(await submit(BOB, RISE_ONLY))
    assert.equal(model.calls, 2)
    assert.deepEqual([bob.attempt.cached, evidence(bob)], [false, 'independent/first_independent_response'])
  })

  it('evaluates again when the task content, its version, or the model changes', async () => {
    ok(await submit(ALICE, RISE_ONLY))
    const changed = makeTask({prompt: 'A reworded question about rising dough.'})
    source.tasks.set(FIXTURE_LESSON.id, {status: 'ok', task: changed})
    const reworded = ok(await submit(ALICE, RISE_ONLY))
    assert.equal(reworded.attempt.cached, false)
    source.tasks.set(FIXTURE_LESSON.id, {status: 'ok', task: makeTask({version: 2})})
    const v2 = ok(await submit(ALICE, RISE_ONLY, {request: {taskVersion: 2}}))
    assert.equal(v2.taskVersion, 2)
    model = explainModel({modelId: 'another-model'})
    ok(await submit(ALICE, RISE_ONLY, {request: {taskVersion: 2}, model}))
    assert.equal(model.calls, 1)
    // Identical text on any version stays a repeat, never new evidence.
    assert.equal(evidence(v2), 'not_counted/repeat_submission')
  })

  it('records a revision after feedback as assisted and linked to what it revises', async () => {
    const first = ok(await submit(ALICE, RISE_ONLY))
    const revised = ok(await submit(ALICE, ACCURATE))
    assert.equal(evidence(revised), 'assisted/revision_after_feedback')
    assert.deepEqual([revised.attempt.number, revised.attempt.revisionOf], [2, first.explanationId])
    const [row] = await db.sql`select feedback_exposed, revision_of from learner.explanation_log where id = ${revised.explanationId}`
    assert.deepEqual([row.feedback_exposed, row.revision_of], [true, first.explanationId])
    const [original] = await db.sql`select evidence_kind, feedback_exposed from learner.explanation_log where id = ${first.explanationId}`
    assert.deepEqual([original.evidence_kind, original.feedback_exposed], ['independent', false])
    assert.deepEqual(await counts(), {explanations: 2, mastery: 0, outbox: 2, help: 0})
  })

  it('treats an off-topic text as judging nothing, and the next real explanation as the first', async () => {
    model = explainModel({explain: (input) => (input.explanation === OFF_TOPIC ? {status: 'off_topic', points: [], followUpQuestion: null} : defaultExplain(input))})
    const off = ok(await submit(ALICE, OFF_TOPIC))
    assert.deepEqual([off.outcome, off.criteria, off.followUpQuestion, evidence(off)], ['off_topic', [], null, 'not_counted/not_assessable'])
    const real = ok(await submit(ALICE, RISE_ONLY))
    assert.deepEqual([evidence(real), real.attempt.revisionOf, real.attempt.number], ['independent/first_independent_response', null, 2])
  })

  it('records help seen on this lesson or its concepts before the explanation, and ignores other lessons', async () => {
    const [instance] = await db.sql<{id: string}[]>`
      insert into learner.task_instance (learner_id, assessment_id, family_id, assessment_version, lesson_id, delivered_option_ids, expires_at)
      values (${ALICE}, 'a-1', 'fam', 1, ${FIXTURE_LESSON.id}, ${db.sql.array(['o1', 'o2', 'o3'])}, now() + interval '1 hour')
      returning id
    `
    await db.sql`
      insert into learner.help_event (learner_id, task_instance_id, family_id, level, policy_version, reason_code, request_key)
      values (${ALICE}, ${instance.id}, 'fam', 1, 'p', 'first_help', 'help-check-000000000001')
    `
    // Help on another lesson changes nothing.
    await db.sql`
      insert into learner.help_event (learner_id, session_id, level, policy_version, reason_code, request_key)
      values (${ALICE}, 'other-session', 3, 'p', 'explicit_solution', 'help-other-000000000001')
    `
    const hinted = ok(await submit(ALICE, RISE_ONLY))
    assert.equal(evidence(hinted), 'assisted/hint_used')

    const [tutorHelp] = await db.sql<{id: string}[]>`
      insert into learner.help_event (learner_id, session_id, level, policy_version, reason_code, request_key)
      values (${BOB}, 'tutor-session-01', 3, 'p', 'explicit_solution', 'help-tutor-000000000001')
      returning id
    `
    await db.sql`
      insert into learner.tutor_request (learner_id, request_key, lesson_id, help_event_id, status, scope, evidence_count, cited_count, prompt_version)
      values (${BOB}, 'help-tutor-000000000001', ${FIXTURE_LESSON.id}, ${tutorHelp.id}, 'supported', 'window', 2, 1, 'tutor-v5')
    `
    const exposed = ok(await submit(BOB, RISE_ONLY))
    assert.equal(evidence(exposed), 'assisted/answer_exposed')
    const [row] = await db.sql`select help_level_before from learner.explanation_log where id = ${exposed.explanationId}`
    assert.equal(row.help_level_before, 3)

    await db.sql`
      insert into learner.help_event (learner_id, session_id, concept_ids, level, policy_version, reason_code, request_key)
      values ('user_carol', 'review-1', ${db.sql.array(['cpt-oven-spring'])}, 2, 'p', 'escalation', 'help-concept-0000000001')
    `
    assert.equal(evidence(ok(await submit('user_carol', RISE_ONLY))), 'assisted/hint_used')
  })

  it('keeps the text through a provider failure, and a retry with the same key evaluates it', async () => {
    const idempotencyKey = key()
    await assert.rejects(submit(ALICE, RISE_ONLY, {model: failingExplainModel(), request: {idempotencyKey}}), AiCallError)
    const [failed] = await db.sql`select evaluation_status, response, outcome, evidence_kind from learner.explanation_log`
    assert.deepEqual([failed.evaluation_status, failed.response, failed.outcome, failed.evidence_kind], ['failed', RISE_ONLY, null, null])
    assert.deepEqual(await counts(), {explanations: 1, mastery: 0, outbox: 0, help: 0})

    const body = ok(await submit(ALICE, RISE_ONLY, {request: {idempotencyKey}}))
    assert.equal(evidence(body), 'independent/first_independent_response')
    const [row] = await db.sql`select evaluation_status, evaluations from learner.explanation_log`
    assert.deepEqual([row.evaluation_status, row.evaluations], ['evaluated', 2])
  })

  it('takes over a claim whose holder is gone after the lease', async () => {
    const idempotencyKey = key()
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const stuck = submit(ALICE, RISE_ONLY, {model: explainModel({gate: () => held}), request: {idempotencyKey}})
    while ((await db.sql`select 1 from learner.explanation_log`).length === 0) await new Promise((resolve) => setTimeout(resolve, 5))
    await db.sql`update learner.explanation_log set claimed_at = now() - interval '10 minutes'`
    const takeover = ok(await submit(ALICE, RISE_ONLY, {request: {idempotencyKey}}))
    release()
    // The first holder finds its claim gone and reports the durable result instead of writing a second one.
    const late = ok(await stuck)
    assert.deepEqual([late.explanationId, late.wasReplayed], [takeover.explanationId, true])
    assert.deepEqual(await counts(), {explanations: 1, mastery: 0, outbox: 1, help: 0})
  })

  it('is a retryable outage, with nothing recorded, when no model is configured', async () => {
    await assert.rejects(submit(ALICE, RISE_ONLY, {model: null}), AiCallError)
    assert.deepEqual(await counts(), {explanations: 0, mastery: 0, outbox: 0, help: 0})
  })

  it('enforces the hourly evaluation budget, without charging reused evaluations', async () => {
    ok(await submit(ALICE, RISE_ONLY, {requestsPerHour: 1}))
    assert.equal(code(await submit(ALICE, ACCURATE, {requestsPerHour: 1})), 'rate_limited')
    assert.equal(ok(await submit(ALICE, RISE_ONLY, {requestsPerHour: 1})).attempt.cached, true)
  })

  it('stores a result with nothing judged either way as deferred, not as a negative result', async () => {
    model = explainModel({
      explain: (input) => ({
        status: 'assessed',
        points: input.points.map(({pointId}) => ({pointId, status: 'insufficient_evidence', quote: null, passages: [], feedback: 'The course does not settle this.'})),
        followUpQuestion: null,
      }),
    })
    const body = ok(await submit(ALICE, RISE_ONLY))
    assert.deepEqual(body.criteria.map((criterion) => criterion.status), ['insufficient_evidence', 'insufficient_evidence', 'insufficient_evidence'])
    const [row] = await db.sql`select evaluation_status from learner.explanation_log`
    assert.equal(row.evaluation_status, 'deferred')
    assert.deepEqual(await counts(), {explanations: 1, mastery: 0, outbox: 1, help: 0})
  })

  it('shows a supported contradiction with server-built citations, and never touches mastery', async () => {
    model = explainModel({
      explain: () => ({
        status: 'assessed',
        points: [
          {pointId: 'c-rise', status: 'contradicted', quote: 'While proofing it cannot rise', passages: ['p1', 'p2'], feedback: 'The lesson says the gluten traps the gas, so the dough rises as it proofs.'},
          {pointId: 'c-set', status: 'contradicted', quote: 'A baked loaf keeps rising for hours', passages: ['p3', 'p4'], feedback: 'The lesson says the heat sets the crumb, so a baked loaf can no longer rise.'},
          {pointId: 'c-salt', status: 'missing', quote: null, passages: [], feedback: 'Think about salt.'},
        ],
        followUpQuestion: 'What does the gluten do with the gas?',
      }),
    })
    const body = ok(await submit(ALICE, REVERSED))
    assert.deepEqual(body.criteria.map((criterion) => [criterion.status, criterion.citations.length]), [
      ['contradicted', 2],
      ['contradicted', 2],
      ['missing', 1],
    ])
    assert.deepEqual(await counts(), {explanations: 1, mastery: 0, outbox: 1, help: 0})
  })

  it('refuses stale, changed, unknown, or unavailable tasks, and out-of-bounds text, before any claim', async () => {
    source.tasks.set(FIXTURE_LESSON.id, {status: 'stale'})
    assert.equal(code(await submit(ALICE, RISE_ONLY)), 'task_unavailable')
    source.tasks.set(FIXTURE_LESSON.id, {status: 'ok', task: makeTask({version: 3})})
    assert.equal(code(await submit(ALICE, RISE_ONLY)), 'task_unavailable')
    assert.equal(code(await submit(ALICE, RISE_ONLY, {request: {taskId: 'another-task', taskVersion: 3}})), 'not_found')
    assert.equal(code(await submit(ALICE, RISE_ONLY, {request: {lessonId: 'lesson-elsewhere', taskVersion: 3}})), 'not_found')
    assert.equal(code(await submit(ALICE, 'too short')), 'invalid_request')
    assert.equal(code(await submit(ALICE, 'x'.repeat(1501))), 'payload_too_large')
    assert.equal(code(await submit(ALICE, `An explanation ${String.fromCharCode(7)} with a bell.`)), 'invalid_request')
    source.fail = true
    await assert.rejects(submit(ALICE, RISE_ONLY, {request: {taskVersion: 3}}), ContentUnavailableError)
    assert.deepEqual([model.calls, await counts()], [0, {explanations: 0, mastery: 0, outbox: 0, help: 0}])
  })
})
