import {randomUUID} from 'node:crypto'

import type {LanguageModel} from 'ai'
import type postgres from 'postgres'

import {
  EXPLAIN_PROMPT_VERSION,
  EXPLAIN_VALIDATOR_VERSION,
  isDeferred,
  runExplanationFeedback,
  type ExplanationAnalysis,
} from '../ai/explain.ts'
import {AiCallError, type AiCallDiagnostics} from '../ai/gateway.ts'
import {asLearner, type LearnerTx} from '../db/learner-scope.ts'
import {hashParts} from '../evidence/chunks.ts'
import {lockLearnerFamily} from '../learner/help-events.ts'
import {CRITERION_STATUSES, explainResponseSchema, type ExplainRequest, type ExplainResponse, type ExplanationEvidenceReason} from './contracts.ts'
import {classifyExplanation, type ExplanationEvidence} from './evidence.ts'
import type {ExplanationTaskSource} from './source.ts'
import {explanationLockKey, type ExplainTask} from './task.ts'
import {normalizeExplanation} from './text.ts'

/**
 * Explain-back feedback (development plan §5 PR-8). One request, in order:
 *
 * 1. Normalize and bound the text; resolve the lesson's published task and
 *    check the requested version and its sources are still current.
 * 2. tx1: replay by idempotency key; reuse this learner's completed
 *    evaluation of identical text on the same task content, prompt,
 *    validator, and model; otherwise claim it (a `pending` row with a lease)
 *    within the hourly budget. Rows are per learner and per key, so a result
 *    is never shared between learners.
 * 3. Outside any transaction: one model call and the server gates
 *    (`lib/ai/explain.ts`). A failure marks the claim `failed`, keeping the
 *    text, and a retry with the same key evaluates again.
 * 4. tx2, under the learner's task lock: complete the row, classify it from
 *    the learner's history (a revision after feedback, help seen before, a
 *    repeat), and write a text-free outbox event.
 *
 * Nothing writes `concept_mastery`, and no text leaves the database row.
 */

export const EXPLANATIONS_PER_HOUR = 20
/** Longer than the model call with its one provider retry, so a live claim is never taken over. */
export const EXPLAIN_LEASE_SECONDS = 90

export type ExplainRejection =
  | 'not_found'
  | 'invalid_request'
  | 'payload_too_large'
  | 'task_unavailable'
  | 'idempotency_key_reused'
  | 'rate_limited'
  | 'explanation_in_progress'

export type ExplainServiceOutcome =
  | {status: 'ok'; body: ExplainResponse; replayed: boolean}
  | {status: 'rejected'; code: ExplainRejection}

const rejected = (code: ExplainRejection): ExplainServiceOutcome => ({status: 'rejected', code})

/** Thrown inside tx2 to roll it back and report a rejection. */
class Rejection extends Error {
  readonly code: ExplainRejection

  constructor(code: ExplainRejection) {
    super(code)
    this.name = 'ExplainRejection'
    this.code = code
  }
}

type RowStatus = 'pending' | 'evaluated' | 'deferred' | 'failed'

type ExplanationRow = {
  id: string
  requestHash: string
  status: RowStatus
  analysis: ExplanationAnalysis | null
  taskId: string
  taskVersion: string
  charCount: number
  modelVersion: string | null
  claimToken: string
  leaseExpired: boolean
  cacheHit: boolean | null
  attemptNumber: number | null
  revisionOf: string | null
  evidenceKind: ExplanationEvidence['kind'] | null
  evidenceReason: ExplanationEvidenceReason | null
}

type CompletedRow = ExplanationRow & {
  status: 'evaluated' | 'deferred'
  analysis: ExplanationAnalysis
  cacheHit: boolean
  attemptNumber: number
  evidenceKind: ExplanationEvidence['kind']
  evidenceReason: ExplanationEvidenceReason
}

const completed = (row: ExplanationRow | null): row is CompletedRow => row?.status === 'evaluated' || row?.status === 'deferred'

const ROW_COLUMNS = (tx: LearnerTx, lease: number) => tx`
  id,
  request_hash as "requestHash",
  evaluation_status as status,
  case when evaluation_status in ('evaluated', 'deferred') then criterion_findings end as analysis,
  task_id as "taskId",
  task_version as "taskVersion",
  char_count as "charCount",
  model_version as "modelVersion",
  claim_token as "claimToken",
  (evaluation_status = 'pending' and claimed_at < now() - ${lease} * interval '1 second') as "leaseExpired",
  cache_hit as "cacheHit",
  attempt_number as "attemptNumber",
  revision_of as "revisionOf",
  evidence_kind as "evidenceKind",
  evidence_reason as "evidenceReason"
`

async function findByKey(tx: LearnerTx, learnerId: string, requestKey: string, lease = EXPLAIN_LEASE_SECONDS): Promise<ExplanationRow | null> {
  const [row] = await tx<ExplanationRow[]>`
    select ${ROW_COLUMNS(tx, lease)} from learner.explanation_log where learner_id = ${learnerId} and request_key = ${requestKey}
  `
  return row ?? null
}

/** This learner's latest completed evaluation under `cacheKey`. */
async function findCached(tx: LearnerTx, learnerId: string, cacheKey: string): Promise<CompletedRow | null> {
  const [row] = await tx<ExplanationRow[]>`
    select ${ROW_COLUMNS(tx, EXPLAIN_LEASE_SECONDS)} from learner.explanation_log
    where learner_id = ${learnerId} and cache_key = ${cacheKey} and evaluation_status in ('evaluated', 'deferred')
    order by completed_at desc, id
    limit 1
  `
  return completed(row ?? null) ? (row as CompletedRow) : null
}

/**
 * Highest help level this learner received before now on the lesson (check
 * hints through their task instance, tutor help through its request) or on
 * the task's concepts. Read under the task lock; 0 when none.
 */
async function lessonHelpLevel(tx: LearnerTx, learnerId: string, lessonId: string, conceptIds: string[]): Promise<number> {
  const [row] = await tx<{level: number}[]>`
    select coalesce(max(h.level), 0)::int as level
    from learner.help_event h
    where h.learner_id = ${learnerId} and (
      h.task_instance_id in (select id from learner.task_instance where learner_id = ${learnerId} and lesson_id = ${lessonId})
      or h.id in (
        select help_event_id from learner.tutor_request
        where learner_id = ${learnerId} and lesson_id = ${lessonId} and help_event_id is not null
      )
      or h.concept_ids && ${tx.array(conceptIds)}::text[]
    )
  `
  return row?.level ?? 0
}

function respond(row: CompletedRow, replayed: boolean): ExplainResponse {
  const {analysis} = row
  return explainResponseSchema.parse({
    explanationId: row.id,
    taskId: row.taskId,
    taskVersion: Number(row.taskVersion),
    outcome: analysis.outcome,
    criteria: analysis.criteria.map(({criterionId, label, required, status, span, feedback, citations}) => ({
      criterionId,
      label,
      required,
      status,
      span,
      feedback,
      citations,
    })),
    followUpQuestion: analysis.followUpQuestion,
    charCount: row.charCount,
    attempt: {
      number: row.attemptNumber,
      revisionOf: row.revisionOf,
      cached: row.cacheHit,
      evidence: {kind: row.evidenceKind, reason: row.evidenceReason},
    },
    replayed,
    provisional: true,
  })
}

type Claim =
  | {kind: 'replay'; row: CompletedRow}
  | {kind: 'hit'; from: CompletedRow}
  | {kind: 'claimed'; id: string; token: string}
  | {kind: 'needs_model'}
  | {kind: 'rejected'; code: ExplainRejection}

export type SubmitExplanationOptions = {
  db: postgres.Sql
  source: ExplanationTaskSource
  /** Null when no provider is configured: an explanation that needs the model is then a retryable outage. */
  model: LanguageModel | null
  learnerId: string
  request: ExplainRequest
  requestsPerHour?: number
  leaseSeconds?: number
  timeoutMs?: number
  log?: (diagnostics: AiCallDiagnostics) => void
}

export async function submitExplanation({
  db,
  source,
  model,
  learnerId,
  request,
  requestsPerHour = EXPLANATIONS_PER_HOUR,
  leaseSeconds = EXPLAIN_LEASE_SECONDS,
  timeoutMs,
  log,
}: SubmitExplanationOptions): Promise<ExplainServiceOutcome> {
  const normalized = normalizeExplanation(request.text)
  if (!normalized.ok) return rejected(normalized.problem === 'too_long' ? 'payload_too_large' : 'invalid_request')
  const {text, charCount} = normalized

  const loaded = await source.loadLessonTask(request.lessonId)
  if (loaded.status === 'none' || (loaded.status === 'ok' && loaded.task.taskId !== request.taskId)) return rejected('not_found')
  if (loaded.status === 'stale' || loaded.task.version !== request.taskVersion) return rejected('task_unavailable')
  const {task} = loaded

  const modelId = model === null ? null : typeof model === 'string' ? model : model.modelId
  const textHash = hashParts(['explanation-text', text])
  const requestHash = hashParts(['explain', request.lessonId, request.taskId, String(request.taskVersion), textHash])
  // No learner id in the key: rows are per learner (`asLearner`, row level security), so a result is never shared.
  const cacheKey = hashParts([task.taskId, String(task.version), task.taskHash, textHash, EXPLAIN_PROMPT_VERSION, EXPLAIN_VALIDATOR_VERSION, modelId ?? 'none'])

  const claim = await asLearner(db, learnerId, async (tx): Promise<Claim> => {
    const budgetSpent = async () => {
      const [{recent}] = await tx<{recent: number}[]>`
        select count(*)::int as recent from learner.explanation_log
        where learner_id = ${learnerId} and claimed_at > now() - interval '1 hour' and cache_hit is not true
      `
      return recent >= requestsPerHour
    }

    const existing = await findByKey(tx, learnerId, request.idempotencyKey, leaseSeconds)
    if (existing) {
      if (existing.requestHash !== requestHash) return {kind: 'rejected', code: 'idempotency_key_reused'}
      if (completed(existing)) return {kind: 'replay', row: existing}
      if (existing.status === 'pending' && !existing.leaseExpired) return {kind: 'rejected', code: 'explanation_in_progress'}
      // A failed evaluation, or a claim whose holder is gone: evaluate again under the same key.
      if (!model) return {kind: 'needs_model'}
      if (await budgetSpent()) return {kind: 'rejected', code: 'rate_limited'}
      const token = randomUUID()
      const [row] = await tx<{id: string}[]>`
        update learner.explanation_log
        set evaluation_status = 'pending', claim_token = ${token}, claimed_at = now(), evaluations = evaluations + 1, model_version = ${modelId}
        where learner_id = ${learnerId} and id = ${existing.id}
          and (evaluation_status = 'failed' or (evaluation_status = 'pending' and claimed_at < now() - ${leaseSeconds} * interval '1 second'))
        returning id
      `
      return row ? {kind: 'claimed', id: row.id, token} : {kind: 'rejected', code: 'explanation_in_progress'}
    }

    const cached = await findCached(tx, learnerId, cacheKey)
    if (cached) return {kind: 'hit', from: cached}
    if (!model) return {kind: 'needs_model'}
    if (await budgetSpent()) return {kind: 'rejected', code: 'rate_limited'}

    const token = randomUUID()
    const [row] = await tx<{id: string}[]>`
      insert into learner.explanation_log
        (learner_id, task_id, task_version, lesson_id, rubric_version, response, evaluation_status, model_version,
         request_key, request_hash, cache_key, response_hash, char_count, task_hash, source_refs, concept_ids,
         prompt_version, validator_version, claim_token, claimed_at)
      values
        (${learnerId}, ${task.taskId}, ${String(task.version)}, ${task.lesson.id}, ${task.rubricHash}, ${text}, 'pending', ${modelId},
         ${request.idempotencyKey}, ${requestHash}, ${cacheKey}, ${textHash}, ${charCount}, ${task.taskHash},
         ${tx.json(sourceRefsOf(task))}, ${tx.array(task.concepts.map((concept) => concept.conceptId))},
         ${EXPLAIN_PROMPT_VERSION}, ${EXPLAIN_VALIDATOR_VERSION}, ${token}, now())
      on conflict (learner_id, request_key) do nothing
      returning id
    `
    // A concurrent request with this key inserted first.
    return row ? {kind: 'claimed', id: row.id, token} : {kind: 'rejected', code: 'explanation_in_progress'}
  })

  if (claim.kind === 'rejected') return rejected(claim.code)
  if (claim.kind === 'replay') return {status: 'ok', body: respond(claim.row, true), replayed: true}
  if (claim.kind === 'needs_model') throw new AiCallError('provider_error', 'The explain-back model is not configured')

  let analysis: ExplanationAnalysis
  if (claim.kind === 'claimed') {
    try {
      analysis = (await runExplanationFeedback({model: model!, task, text, timeoutMs, log})).analysis
    } catch (error) {
      // The text stays on the row; a retry with the same key evaluates it again.
      await asLearner(db, learnerId, (tx) => tx`
        update learner.explanation_log set evaluation_status = 'failed'
        where learner_id = ${learnerId} and id = ${claim.id} and claim_token = ${claim.token} and evaluation_status = 'pending'
      `)
      throw error
    }
  } else {
    analysis = claim.from.analysis
  }

  try {
    const {row, replayed} = await asLearner(db, learnerId, (tx) =>
      record(tx, {learnerId, request, requestHash, cacheKey, task, text, textHash, charCount, claim, analysis, modelId}),
    )
    return {status: 'ok', body: respond(row, replayed), replayed}
  } catch (error) {
    if (error instanceof Rejection) return rejected(error.code)
    throw error
  }
}

const sourceRefsOf = (task: ExplainTask) => task.evidence.map(({chunkId, chunkRevision}) => ({chunkId, chunkRevision}))

function statusCounts(analysis: ExplanationAnalysis, required: boolean): Record<string, number> {
  return Object.fromEntries(
    CRITERION_STATUSES.map((status) => [status, analysis.criteria.filter((criterion) => criterion.required === required && criterion.status === status).length]),
  )
}

/** tx2: complete the row (or record a reused evaluation), classify it, and write its outbox event together. */
async function record(
  tx: LearnerTx,
  {
    learnerId,
    request,
    requestHash,
    cacheKey,
    task,
    text,
    textHash,
    charCount,
    claim,
    analysis,
    modelId,
  }: {
    learnerId: string
    request: ExplainRequest
    requestHash: string
    cacheKey: string
    task: ExplainTask
    text: string
    textHash: string
    charCount: number
    claim: Extract<Claim, {kind: 'hit' | 'claimed'}>
    analysis: ExplanationAnalysis
    modelId: string | null
  },
): Promise<{row: CompletedRow; replayed: boolean}> {
  // Serializes this learner's explanations of the task, so the history read below is not stale.
  await lockLearnerFamily(tx, learnerId, explanationLockKey(task.taskId))

  const current = await findByKey(tx, learnerId, request.idempotencyKey)
  if (current && current.requestHash !== requestHash) throw new Rejection('idempotency_key_reused')
  // A concurrent request with this key finished first: its result is the durable one.
  if (completed(current)) return {row: current, replayed: true}
  if (claim.kind === 'claimed') {
    // Another request took the claim over after the lease; it may still be running.
    if (!current || current.id !== claim.id || current.claimToken !== claim.token || current.status !== 'pending') {
      throw new Rejection('explanation_in_progress')
    }
  } else if (current) {
    throw new Rejection('explanation_in_progress')
  }

  const [history] = await tx<{prior: number; priorAssessed: number; identical: boolean; latestAssessed: string | null}[]>`
    select
      count(*)::int as prior,
      (count(*) filter (where outcome = 'assessed'))::int as "priorAssessed",
      coalesce(bool_or(response_hash = ${textHash}), false) as identical,
      (array_agg(id order by completed_at desc, id) filter (where outcome = 'assessed'))[1] as "latestAssessed"
    from learner.explanation_log
    where learner_id = ${learnerId} and task_id = ${task.taskId} and evaluation_status in ('evaluated', 'deferred')
  `
  const helpLevelBefore = await lessonHelpLevel(tx, learnerId, task.lesson.id, task.concepts.map((concept) => concept.conceptId))
  const evidence = classifyExplanation({
    outcome: analysis.outcome,
    identicalBefore: history.identical,
    priorAssessed: history.priorAssessed,
    helpLevelBefore,
  })
  const status = isDeferred(analysis) ? 'deferred' : 'evaluated'
  const findings = tx.json(analysis as unknown as postgres.JSONValue)
  const completion = {
    revisionOf: history.latestAssessed,
    attemptNumber: history.prior + 1,
    feedbackExposed: history.priorAssessed > 0,
  }

  let id: string
  if (claim.kind === 'claimed') {
    const [row] = await tx<{id: string}[]>`
      update learner.explanation_log
      set evaluation_status = ${status}, outcome = ${analysis.outcome}, criterion_findings = ${findings}, model_version = ${modelId},
          completed_at = now(), cache_hit = false, revision_of = ${completion.revisionOf}, attempt_number = ${completion.attemptNumber},
          feedback_exposed = ${completion.feedbackExposed}, help_level_before = ${helpLevelBefore},
          evidence_kind = ${evidence.kind}, evidence_reason = ${evidence.reason}
      where learner_id = ${learnerId} and id = ${claim.id} and claim_token = ${claim.token} and evaluation_status = 'pending'
      returning id
    `
    if (!row) throw new Rejection('explanation_in_progress')
    id = row.id
  } else {
    const from = claim.from
    const [row] = await tx<{id: string}[]>`
      insert into learner.explanation_log
        (learner_id, task_id, task_version, lesson_id, rubric_version, response, criterion_findings, evaluation_status, model_version,
         request_key, request_hash, cache_key, response_hash, char_count, task_hash, source_refs, concept_ids,
         prompt_version, validator_version, outcome, claim_token, claimed_at, completed_at, cache_hit, reused_from,
         revision_of, attempt_number, feedback_exposed, help_level_before, evidence_kind, evidence_reason)
      values
        (${learnerId}, ${task.taskId}, ${String(task.version)}, ${task.lesson.id}, ${task.rubricHash}, ${text}, ${findings}, ${status},
         ${from.modelVersion}, ${request.idempotencyKey}, ${requestHash}, ${cacheKey}, ${textHash}, ${charCount}, ${task.taskHash},
         ${tx.json(sourceRefsOf(task))}, ${tx.array(task.concepts.map((concept) => concept.conceptId))},
         ${EXPLAIN_PROMPT_VERSION}, ${EXPLAIN_VALIDATOR_VERSION}, ${analysis.outcome}, ${randomUUID()}, now(), now(), true, ${from.id},
         ${completion.revisionOf}, ${completion.attemptNumber}, ${completion.feedbackExposed}, ${helpLevelBefore}, ${evidence.kind}, ${evidence.reason})
      on conflict (learner_id, request_key) do nothing
      returning id
    `
    if (!row) throw new Rejection('explanation_in_progress')
    id = row.id
  }

  // Ids, enums, counts, and versions only: no explanation or feedback text leaves the row.
  await tx`
    insert into learner.event_outbox (event_type, payload)
    values ('explanation_evaluated', ${tx.json({
      explanationId: id,
      learnerId,
      taskId: task.taskId,
      taskVersion: task.version,
      lessonId: task.lesson.id,
      outcome: analysis.outcome,
      evaluationStatus: status,
      required: statusCounts(analysis, true),
      optional: statusCounts(analysis, false),
      adjustedByServer: analysis.dropped.length,
      cacheHit: claim.kind === 'hit',
      attemptNumber: completion.attemptNumber,
      revisionOf: completion.revisionOf,
      feedbackExposed: completion.feedbackExposed,
      helpLevelBefore,
      evidenceKind: evidence.kind,
      evidenceReason: evidence.reason,
      // A model's reading against the task's points: never a grade or mastery evidence.
      promptVersion: EXPLAIN_PROMPT_VERSION,
      validatorVersion: EXPLAIN_VALIDATOR_VERSION,
      modelId: claim.kind === 'hit' ? claim.from.modelVersion : modelId,
    })})
  `

  const row = await findByKey(tx, learnerId, request.idempotencyKey)
  if (!completed(row)) throw new Error('A completed explanation must read back as completed')
  return {row, replayed: false}
}
