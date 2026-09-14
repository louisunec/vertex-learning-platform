import {randomUUID} from 'node:crypto'

import type {LanguageModel} from 'ai'
import type postgres from 'postgres'

import type {AiCallDiagnostics} from '../ai/gateway.ts'
import {AiCallError} from '../ai/gateway.ts'
import {decideHelpLevel, HELP_POLICY_VERSION, type HelpDecision, type HelpLevel, type HelpReasonCode} from '../ai/help-policy.ts'
import {REVIEW_CHECK_PROMPT_VERSION} from '../ai/review-check.ts'
import {
  hasHelpWorthyFindings,
  presentFindings,
  REVIEW_PROMPT_VERSION,
  runSubmissionReview,
  type ReviewAnalysis,
} from '../ai/review.ts'
import {asLearner, type LearnerTx} from '../db/learner-scope.ts'
import {hashParts} from '../evidence/chunks.ts'
import {getFamilyHelpState, getSessionHelpLevel, lockLearnerFamily} from '../learner/help-events.ts'
import {FINDING_CATEGORIES, reviewResponseSchema, type ReviewHelpRequest, type ReviewResponse, type ReviewSubmitRequest} from './contracts.ts'
import {classifySubmission, type SubmissionEvidence} from './evidence.ts'
import type {SubmissionTaskSource} from './source.ts'
import {helpFamilyKey, helpSessionKey, type SubmissionTask} from './task.ts'
import {normalizeSubmission, type NormalizedSubmission} from './text.ts'

/**
 * Submission review (development plan §5 PR-12). A review request, in order:
 *
 * 1. Normalize and bound the code; resolve the lesson's published task and
 *    check the requested version and its sources are still current.
 * 2. tx1: replay by request key; reuse this learner's completed analysis of
 *    the same code on the same task content, prompt, and model; otherwise
 *    claim it (a `pending` row with a lease) within the hourly budget.
 * 3. Outside any transaction: the answer and check calls (`lib/ai/review.ts`).
 *    A failure marks the claim `failed` and records nothing else.
 * 4. tx2, under the learner's task lock: complete the claim, classify the
 *    submission from the learner's history, deliver help at the policy's
 *    level (PR-5: a new review starts at level 1; showing a review again
 *    repeats the level it reached and never escalates), and write the log
 *    and outbox events.
 *
 * A help request escalates on a stored analysis, with no model call. The
 * help ladder is scoped per review, and assistance per task across versions
 * (`task.ts`). Nothing writes `concept_mastery`, and no code or feedback
 * text reaches the outbox.
 */

export const REVIEWS_PER_HOUR = 20
/** Longer than both model calls together, so a live claim is never taken over. */
export const REVIEW_LEASE_SECONDS = 90

export type ReviewRejection =
  | 'not_found'
  | 'invalid_request'
  | 'payload_too_large'
  | 'task_unavailable'
  | 'idempotency_key_reused'
  | 'rate_limited'
  | 'review_in_progress'
  | 'hint_unavailable'

export type ReviewServiceOutcome =
  | {status: 'ok'; body: ReviewResponse; replayed: boolean}
  | {status: 'rejected'; code: ReviewRejection}

const rejected = (code: ReviewRejection): ReviewServiceOutcome => ({status: 'rejected', code})

/** Thrown inside tx2 to roll it back and report a rejection. */
class Rejection extends Error {
  readonly code: ReviewRejection

  constructor(code: ReviewRejection) {
    super(code)
    this.code = code
  }
}

type ReviewRow = {
  id: string
  taskId: string
  taskVersion: number
  taskHash: string
  lessonId: string
  status: 'pending' | 'completed' | 'failed'
  analysis: ReviewAnalysis | null
  leaseExpired: boolean
}

type LogRow = {
  id: string
  requestHash: string
  reviewId: string
  cacheHit: boolean
  evidenceKind: SubmissionEvidence['kind']
  evidenceReason: SubmissionEvidence['reason']
  helpLevel: number
  helpEventId: string | null
}

type HelpRow = {id: string; sessionId: string | null; level: number; reasonCode: HelpReasonCode}

const REVIEW_COLUMNS = (tx: LearnerTx, lease: number) => tx`
  id,
  task_id as "taskId",
  task_version as "taskVersion",
  task_hash as "taskHash",
  lesson_id as "lessonId",
  status,
  analysis,
  (status = 'pending' and claimed_at < now() - ${lease} * interval '1 second') as "leaseExpired"
`

async function findReview(tx: LearnerTx, learnerId: string, by: {id: string} | {cacheKey: string}, lease = REVIEW_LEASE_SECONDS): Promise<ReviewRow | null> {
  const [row] =
    'id' in by
      ? await tx<ReviewRow[]>`select ${REVIEW_COLUMNS(tx, lease)} from learner.submission_review where learner_id = ${learnerId} and id = ${by.id}`
      : await tx<ReviewRow[]>`select ${REVIEW_COLUMNS(tx, lease)} from learner.submission_review where learner_id = ${learnerId} and cache_key = ${by.cacheKey}`
  return row ?? null
}

async function findLog(tx: LearnerTx, learnerId: string, requestKey: string): Promise<LogRow | null> {
  const [row] = await tx<LogRow[]>`
    select
      id,
      request_hash as "requestHash",
      review_id as "reviewId",
      cache_hit as "cacheHit",
      evidence_kind as "evidenceKind",
      evidence_reason as "evidenceReason",
      help_level as "helpLevel",
      help_event_id as "helpEventId"
    from learner.submission_log
    where learner_id = ${learnerId} and request_key = ${requestKey}
  `
  return row ?? null
}

async function findHelp(tx: LearnerTx, learnerId: string, by: {id: string} | {requestKey: string}): Promise<HelpRow | null> {
  const [row] =
    'id' in by
      ? await tx<HelpRow[]>`
          select id, session_id as "sessionId", level, reason_code as "reasonCode"
          from learner.help_event where learner_id = ${learnerId} and id = ${by.id}`
      : await tx<HelpRow[]>`
          select id, session_id as "sessionId", level, reason_code as "reasonCode"
          from learner.help_event where learner_id = ${learnerId} and request_key = ${by.requestKey}`
  return row ?? null
}

/** Records help on a review (no task instance): policy scope per review, assistance scope per task. */
async function insertTaskHelp(
  tx: LearnerTx,
  learnerId: string,
  {requestKey, reviewId, taskId, conceptIds, decision}: {requestKey: string; reviewId: string; taskId: string; conceptIds: string[]; decision: HelpDecision},
): Promise<string | null> {
  const [row] = await tx<{id: string}[]>`
    insert into learner.help_event
      (learner_id, task_instance_id, session_id, family_id, concept_ids, level, explicit_override, policy_version, reason_code, request_key)
    values
      (${learnerId}, null, ${helpSessionKey(reviewId)}, ${helpFamilyKey(taskId)}, ${tx.array(conceptIds)},
       ${decision.level}, ${decision.explicitOverride}, ${decision.policyVersion}, ${decision.reasonCode}, ${requestKey})
    on conflict (learner_id, request_key) do nothing
    returning id
  `
  if (!row) return null
  // Ids and enums only: no code or feedback text leaves the request path.
  await tx`
    insert into learner.event_outbox (event_type, payload)
    values ('help_level_decided', ${tx.json({
      helpEventId: row.id,
      learnerId,
      source: 'submission_review',
      taskInstanceId: null,
      reviewId,
      familyId: helpFamilyKey(taskId),
      sessionId: helpSessionKey(reviewId),
      level: decision.level,
      reasonCode: decision.reasonCode,
      explicitOverride: decision.explicitOverride,
      policyVersion: decision.policyVersion,
    })})
  `
  return row.id
}

const conceptIdsOf = (analysis: ReviewAnalysis, task: SubmissionTask | null) =>
  [...new Set([...(task?.concepts.map((concept) => concept.conceptId) ?? []), ...analysis.findings.flatMap((finding) => finding.concepts.map((concept) => concept.conceptId))])].slice(0, 8)

function respond({
  review,
  level,
  help,
  submission,
  replayed,
}: {
  review: ReviewRow & {analysis: ReviewAnalysis}
  level: number
  help: {id: string; reasonCode: HelpReasonCode} | null
  submission: ReviewResponse['submission']
  replayed: boolean
}): ReviewResponse {
  const {analysis} = review
  return reviewResponseSchema.parse({
    reviewId: review.id,
    taskId: review.taskId,
    taskVersion: review.taskVersion,
    outcome: analysis.outcome,
    cannotJudgeReason: analysis.cannotJudgeReason,
    criteria: analysis.criteria,
    findings: presentFindings(analysis.findings, level as HelpLevel),
    help: {level, reasonCode: help?.reasonCode ?? null, helpEventId: help?.id ?? null, policyVersion: HELP_POLICY_VERSION},
    submission,
    replayed,
    provisional: true,
  })
}

const completed = (review: ReviewRow | null): review is ReviewRow & {analysis: ReviewAnalysis} => review?.status === 'completed' && review.analysis !== null

/** The stored response for a logged request. */
async function replayLog(tx: LearnerTx, learnerId: string, log: LogRow): Promise<ReviewResponse> {
  const review = await findReview(tx, learnerId, {id: log.reviewId})
  if (!completed(review)) throw new Error('A logged submission must reference a completed review')
  const help = log.helpEventId ? await findHelp(tx, learnerId, {id: log.helpEventId}) : null
  return respond({
    review,
    level: log.helpLevel,
    help,
    submission: {submissionId: log.id, cached: log.cacheHit, evidence: {kind: log.evidenceKind, reason: log.evidenceReason}},
    replayed: true,
  })
}

type Claim =
  | {kind: 'replay'; body: ReviewResponse}
  | {kind: 'hit'; review: ReviewRow & {analysis: ReviewAnalysis}}
  | {kind: 'claimed'; reviewId: string; token: string}
  | {kind: 'needs_model'}
  | {kind: 'rejected'; code: ReviewRejection}

export type SubmitOptions = {
  db: postgres.Sql
  source: SubmissionTaskSource
  /** Null when no provider is configured: a review that needs the model is then a retryable outage. */
  model: LanguageModel | null
  learnerId: string
  request: ReviewSubmitRequest
  requestsPerHour?: number
  leaseSeconds?: number
  timeoutMs?: number
  log?: (diagnostics: AiCallDiagnostics) => void
}

export async function submitForReview({
  db,
  source,
  model,
  learnerId,
  request,
  requestsPerHour = REVIEWS_PER_HOUR,
  leaseSeconds = REVIEW_LEASE_SECONDS,
  timeoutMs,
  log,
}: SubmitOptions): Promise<ReviewServiceOutcome> {
  const normalized = normalizeSubmission(request.submission.content)
  if (!normalized.ok) return rejected(normalized.problem === 'too_long' || normalized.problem === 'too_many_lines' ? 'payload_too_large' : 'invalid_request')
  const submission = normalized.value

  const loaded = await source.loadLessonTask(request.lessonId)
  if (loaded.status === 'none' || (loaded.status === 'ok' && loaded.task.taskId !== request.taskId)) return rejected('not_found')
  if (loaded.status === 'stale' || loaded.task.version !== request.taskVersion) return rejected('task_unavailable')
  const {task} = loaded

  const modelId = model === null ? null : typeof model === 'string' ? model : model.modelId
  const contentHash = hashParts([submission.content])
  const requestHash = hashParts(['review', request.lessonId, request.taskId, String(request.taskVersion), contentHash])
  // No learner id in the key: the unique (learner_id, cache_key) constraint and row level security scope it.
  const cacheKey = hashParts([task.taskId, String(task.version), task.taskHash, contentHash, REVIEW_PROMPT_VERSION, REVIEW_CHECK_PROMPT_VERSION, modelId ?? 'none'])

  const claim = await asLearner(db, learnerId, async (tx): Promise<Claim> => {
    const logged = await findLog(tx, learnerId, request.requestKey)
    if (logged) return logged.requestHash === requestHash ? {kind: 'replay', body: await replayLog(tx, learnerId, logged)} : {kind: 'rejected', code: 'idempotency_key_reused'}

    const review = await findReview(tx, learnerId, {cacheKey}, leaseSeconds)
    if (completed(review)) return {kind: 'hit', review}
    if (review?.status === 'pending' && !review.leaseExpired) return {kind: 'rejected', code: 'review_in_progress'}
    if (!model) return {kind: 'needs_model'}

    const [{recent}] = await tx<{recent: number}[]>`
      select count(*)::int as recent from learner.submission_review
      where learner_id = ${learnerId} and claimed_at > now() - interval '1 hour'
    `
    if (recent >= requestsPerHour) return {kind: 'rejected', code: 'rate_limited'}

    const token = randomUUID()
    if (review) {
      // A failed evaluation, or a claim whose holder is gone: take it over.
      const [row] = await tx<{id: string}[]>`
        update learner.submission_review
        set status = 'pending', claim_token = ${token}, claimed_at = now(), evaluations = evaluations + 1
        where learner_id = ${learnerId} and id = ${review.id}
          and (status = 'failed' or (status = 'pending' and claimed_at < now() - ${leaseSeconds} * interval '1 second'))
        returning id
      `
      return row ? {kind: 'claimed', reviewId: row.id, token} : {kind: 'rejected', code: 'review_in_progress'}
    }
    const [row] = await tx<{id: string}[]>`
      insert into learner.submission_review
        (learner_id, cache_key, task_id, task_version, task_hash, lesson_id, content_hash, line_count,
         prompt_version, check_version, model_id, status, claim_token)
      values
        (${learnerId}, ${cacheKey}, ${task.taskId}, ${task.version}, ${task.taskHash}, ${task.lesson.id}, ${contentHash}, ${submission.lineCount},
         ${REVIEW_PROMPT_VERSION}, ${REVIEW_CHECK_PROMPT_VERSION}, ${modelId}, 'pending', ${token})
      on conflict (learner_id, cache_key) do nothing
      returning id
    `
    return row ? {kind: 'claimed', reviewId: row.id, token} : {kind: 'rejected', code: 'review_in_progress'}
  })

  if (claim.kind === 'rejected') return rejected(claim.code)
  if (claim.kind === 'replay') return {status: 'ok', body: claim.body, replayed: true}
  if (claim.kind === 'needs_model') throw new AiCallError('provider_error', 'The review model is not configured')

  let analysis: ReviewAnalysis | null = null
  if (claim.kind === 'claimed') {
    try {
      analysis = (await runSubmissionReview({model: model!, task, submission, timeoutMs, log})).analysis
    } catch (error) {
      await asLearner(db, learnerId, (tx) => tx`
        update learner.submission_review set status = 'failed'
        where learner_id = ${learnerId} and id = ${claim.reviewId} and claim_token = ${claim.token} and status = 'pending'
      `)
      throw error
    }
  }

  try {
    const body = await asLearner(db, learnerId, (tx) => record(tx, {learnerId, request, requestHash, task, submission, contentHash, claim, analysis}))
    return {status: 'ok', body, replayed: body.replayed}
  } catch (error) {
    if (error instanceof Rejection) return rejected(error.code)
    throw error
  }
}

/** tx2: complete the claim, then record the submission, its help, and outbox events together. */
async function record(
  tx: LearnerTx,
  {
    learnerId,
    request,
    requestHash,
    task,
    submission,
    contentHash,
    claim,
    analysis,
  }: {
    learnerId: string
    request: ReviewSubmitRequest
    requestHash: string
    task: SubmissionTask
    submission: NormalizedSubmission
    contentHash: string
    claim: Extract<Claim, {kind: 'hit' | 'claimed'}>
    analysis: ReviewAnalysis | null
  },
): Promise<ReviewResponse> {
  // Serializes submissions and help on this task, so the history read below is not stale.
  await lockLearnerFamily(tx, learnerId, helpFamilyKey(task.taskId))

  // A concurrent request with this key committed first.
  const logged = await findLog(tx, learnerId, request.requestKey)
  if (logged) {
    if (logged.requestHash !== requestHash) throw new Rejection('idempotency_key_reused')
    return replayLog(tx, learnerId, logged)
  }

  let review: ReviewRow & {analysis: ReviewAnalysis}
  if (claim.kind === 'claimed') {
    // Matches nothing when another request took the claim over after the lease.
    await tx`
      update learner.submission_review
      set status = 'completed', outcome = ${analysis!.outcome}, analysis = ${tx.json(analysis as unknown as postgres.JSONValue)}, completed_at = now()
      where learner_id = ${learnerId} and id = ${claim.reviewId} and claim_token = ${claim.token} and status = 'pending'
    `
    const current = await findReview(tx, learnerId, {id: claim.reviewId})
    // That other request may still be running; if it finished, its analysis is as good as ours.
    if (!completed(current)) throw new Rejection('review_in_progress')
    review = current
  } else {
    review = claim.review
  }

  const [{prior, identical}] = await tx<{prior: number; identical: boolean}[]>`
    select count(*)::int as prior, coalesce(bool_or(content_hash = ${contentHash}), false) as identical
    from learner.submission_log
    where learner_id = ${learnerId} and task_id = ${task.taskId}
  `
  const helpBefore = await getFamilyHelpState(tx, learnerId, helpFamilyKey(task.taskId))
  const evidence = classifySubmission({identicalBefore: identical, priorSubmissions: prior, helpLevelBefore: helpBefore.maxLevel})

  // Help rides along with a review only when there is a problem to help with; a review never escalates.
  let level = 0
  let help: {id: string; reasonCode: HelpReasonCode} | null = null
  if (hasHelpWorthyFindings(review.analysis)) {
    const currentLevel = (await getSessionHelpLevel(tx, learnerId, helpSessionKey(review.id))) as HelpLevel
    const decision = decideHelpLevel({mode: 'study', request: 'hint', currentLevel})
    const helpEventId = await insertTaskHelp(tx, learnerId, {
      requestKey: request.requestKey,
      reviewId: review.id,
      taskId: task.taskId,
      conceptIds: conceptIdsOf(review.analysis, task),
      decision,
    })
    // The key was already used for another help request or tutor question.
    if (!helpEventId) throw new Rejection('idempotency_key_reused')
    level = decision.level
    help = {id: helpEventId, reasonCode: decision.reasonCode}
  }

  const cacheHit = claim.kind === 'hit'
  const [row] = await tx<{id: string}[]>`
    insert into learner.submission_log
      (learner_id, request_key, request_hash, review_id, task_id, task_version, lesson_id, content_hash, line_count, char_count,
       cache_hit, evidence_kind, evidence_reason, help_level_before, help_level, help_event_id)
    values
      (${learnerId}, ${request.requestKey}, ${requestHash}, ${review.id}, ${task.taskId}, ${task.version}, ${task.lesson.id}, ${contentHash},
       ${submission.lineCount}, ${submission.charCount}, ${cacheHit}, ${evidence.kind}, ${evidence.reason}, ${helpBefore.maxLevel}, ${level}, ${help?.id ?? null})
    returning id
  `

  const counts = Object.fromEntries(FINDING_CATEGORIES.map((category) => [category, review.analysis.findings.filter((finding) => finding.category === category).length]))
  await tx`
    insert into learner.event_outbox (event_type, payload)
    values ('submission_reviewed', ${tx.json({
      submissionId: row.id,
      learnerId,
      reviewId: review.id,
      taskId: task.taskId,
      taskVersion: task.version,
      lessonId: task.lesson.id,
      outcome: review.analysis.outcome,
      findings: counts,
      droppedFindings: review.analysis.dropped.length,
      cacheHit,
      evidenceKind: evidence.kind,
      evidenceReason: evidence.reason,
      helpLevel: level,
      helpEventId: help?.id ?? null,
      // Model-assisted, provisional: never a grade or mastery evidence.
      promptVersion: REVIEW_PROMPT_VERSION,
      checkVersion: REVIEW_CHECK_PROMPT_VERSION,
    })})
  `

  return respond({
    review,
    level,
    help,
    submission: {submissionId: row.id, cached: cacheHit, evidence},
    replayed: false,
  })
}

/**
 * More help on a stored review: the PR-5 policy decides the level from the
 * help already given on that review (`escalate` 1→2→3, `solution` → 3),
 * and the stored analysis is disclosed at it. No model call. The task must
 * still be published at the content the review judged.
 */
export async function requestReviewHelp({
  db,
  source,
  learnerId,
  request,
}: {
  db: postgres.Sql
  source: SubmissionTaskSource
  learnerId: string
  request: ReviewHelpRequest
}): Promise<ReviewServiceOutcome> {
  const checked = await asLearner(db, learnerId, async (tx) => {
    const review = await findReview(tx, learnerId, {id: request.reviewId})
    if (!completed(review)) return null
    return {review, stored: await findHelp(tx, learnerId, {requestKey: request.requestKey})}
  })
  // Another learner's review is indistinguishable from none.
  if (!checked) return rejected('not_found')
  const {review, stored} = checked
  const session = helpSessionKey(review.id)
  if (stored && stored.sessionId !== session) return rejected('idempotency_key_reused')

  const loaded = await source.loadLessonTask(review.lessonId)
  if (loaded.status !== 'ok' || loaded.task.taskId !== review.taskId || loaded.task.taskHash !== review.taskHash) return rejected('task_unavailable')
  const task = loaded.task

  const present = (event: HelpRow, replayed: boolean): ReviewServiceOutcome => ({
    status: 'ok',
    body: respond({review, level: event.level, help: event, submission: null, replayed}),
    replayed,
  })
  if (stored) return present(stored, true)
  if (!hasHelpWorthyFindings(review.analysis)) return rejected('hint_unavailable')

  const outcome = await asLearner(db, learnerId, async (tx): Promise<{event: HelpRow; replayed: boolean} | ReviewRejection> => {
    await lockLearnerFamily(tx, learnerId, helpFamilyKey(review.taskId))
    const earlier = await findHelp(tx, learnerId, {requestKey: request.requestKey})
    if (earlier) return earlier.sessionId === session ? {event: earlier, replayed: true} : 'idempotency_key_reused'

    const currentLevel = (await getSessionHelpLevel(tx, learnerId, session)) as HelpLevel
    const decision = decideHelpLevel({mode: 'study', request: request.request, currentLevel})
    const id = await insertTaskHelp(tx, learnerId, {
      requestKey: request.requestKey,
      reviewId: review.id,
      taskId: review.taskId,
      conceptIds: conceptIdsOf(review.analysis, task),
      decision,
    })
    if (!id) return 'idempotency_key_reused'
    return {event: {id, sessionId: session, level: decision.level, reasonCode: decision.reasonCode}, replayed: false}
  })
  return typeof outcome === 'string' ? rejected(outcome) : present(outcome.event, outcome.replayed)
}
