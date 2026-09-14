import type {LanguageModel} from 'ai'
import type postgres from 'postgres'

import {AiCallError} from '../ai/gateway.ts'
import {decideHelpLevel, type HelpDecision, type HelpLevel} from '../ai/help-policy.ts'
import {
  answerTutorQuestion,
  CLARIFYING_QUESTION,
  INSUFFICIENT_EVIDENCE_MESSAGE,
  TUTOR_PROMPT_VERSION,
  type RetrievalScope,
  type TutorAnswer,
  type TutorStatus,
} from '../ai/tutor.ts'
import {TUTOR_SUPPORT_PROMPT_VERSION} from '../ai/tutor-support.ts'
import {asLearner, type LearnerTx} from '../db/learner-scope.ts'
import {tutorResponseSchema, type TutorRequest, type TutorResponse} from '../learner/contracts.ts'
import {
  findHelpEventByKey,
  getInstanceHelpLevel,
  getSessionHelpLevel,
  insertHelpEvent,
  lockLearnerFamily,
} from '../learner/help-events.ts'
import {findOwnedTaskInstance, type TaskInstanceRow} from '../learner/task-instances.ts'
import {resolveLessonScope, retrieveEvidence} from './retrieve.ts'
import type {TutorSource} from './source.ts'
import {deterministicTerms} from './terms.ts'

/**
 * The time-anchored tutor (development plan §5 PR-6). In order:
 *
 * 1. Resolve the published lesson and check the playhead against its duration.
 * 2. tx1: replay check, task ownership and lesson match, hourly budget, and
 *    the help level already given on the task instance or session.
 * 3. Make retrieval terms without a model (`./terms.ts`: the learner's
 *    words and a fixed word list; a model expansion call was measured and
 *    dropped, `docs/evals/pr-6-tutor-comparison.md`), retrieve bounded
 *    evidence, decide the level (PR-5 policy), and, unless the request
 *    needs clarifying or nothing was found, answer and support-check it
 *    (two model calls; `lib/ai/tutor.ts`).
 * 4. tx2: record the request, the help event when help was delivered, and
 *    their outbox events.
 *
 * The model call never runs inside a transaction, and nothing is recorded
 * when it fails: a failed call must not mark a task as assisted with help
 * that was never shown. The price is that two concurrent requests with
 * different keys can record the same level (`/api/help` serializes the
 * decision and the insert; here the model call sits between them). No
 * question, answer, or source text is stored or sent to the outbox.
 */

export const TUTOR_REQUESTS_PER_HOUR = 30

export type TutorRejection = 'not_found' | 'invalid_request' | 'already_answered' | 'idempotency_key_reused' | 'rate_limited'

export type AskTutorOutcome = {status: 'answered'; body: TutorResponse} | {status: 'rejected'; code: TutorRejection}

const rejected = (code: TutorRejection): AskTutorOutcome => ({status: 'rejected', code})

/** Thrown inside tx2 to roll back and report a rejection. */
class Rejection extends Error {
  readonly code: TutorRejection

  constructor(code: TutorRejection) {
    super(code)
    this.code = code
  }
}

async function tutorRequestExists(tx: LearnerTx, learnerId: string, requestKey: string): Promise<boolean> {
  const [row] = await tx`select 1 from learner.tutor_request where learner_id = ${learnerId} and request_key = ${requestKey}`
  return Boolean(row)
}

type Checked = {instance: TaskInstanceRow | null; currentLevel: HelpLevel}

type Outcome = {
  status: TutorStatus
  answer: TutorAnswer | null
  evidenceCount: number
  modelId: string | null
}

export async function askTutor({
  db,
  source,
  model,
  learnerId,
  request,
  requestsPerHour = TUTOR_REQUESTS_PER_HOUR,
  timeoutMs,
}: {
  db: postgres.Sql
  source: TutorSource
  /** Null when no provider is configured: a question that needs the model is then a retryable outage. */
  model: LanguageModel | null
  learnerId: string
  request: TutorRequest
  requestsPerHour?: number
  timeoutMs?: number
}): Promise<AskTutorOutcome> {
  const scope = await resolveLessonScope(source, request.lessonId)
  if (!scope) return rejected('not_found')
  if (scope.durationSeconds !== null && request.currentSeconds > scope.durationSeconds) return rejected('invalid_request')

  const checked = await asLearner(db, learnerId, async (tx): Promise<Checked | TutorRejection> => {
    // Help event first, tutor request last: tx2 commits both together, so a concurrent duplicate
    // that commits between these statements is still seen as this request (READ COMMITTED).
    const helpEvent = await findHelpEventByKey(tx, learnerId, request.requestKey)
    if (await tutorRequestExists(tx, learnerId, request.requestKey)) return 'already_answered'
    if (helpEvent) return 'idempotency_key_reused'

    let instance: TaskInstanceRow | null = null
    if (request.taskInstanceId) {
      instance = await findOwnedTaskInstance(tx, learnerId, request.taskInstanceId)
      if (!instance || instance.lessonId !== scope.lesson.id) return 'not_found'
    }

    const [{recent}] = await tx<{recent: number}[]>`
      select count(*)::int as recent from learner.tutor_request
      where learner_id = ${learnerId} and created_at > now() - interval '1 hour'
    `
    if (recent >= requestsPerHour) return 'rate_limited'

    const currentLevel = instance
      ? await getInstanceHelpLevel(tx, learnerId, instance.id)
      : request.sessionId
        ? await getSessionHelpLevel(tx, learnerId, request.sessionId)
        : 0
    return {instance, currentLevel: currentLevel as HelpLevel}
  })
  if (typeof checked === 'string') return rejected(checked)
  const {instance, currentLevel} = checked

  const {baseTerms, terms} = deterministicTerms(request.question)
  const retrieval = await retrieveEvidence(source, scope, {currentSeconds: request.currentSeconds, terms, baseTerms})
  const decision = decideHelpLevel({
    mode: request.mode,
    request: request.helpRequest ?? 'hint',
    currentLevel,
    // Nothing to anchor on: no topic words and no transcript at the playhead.
    ambiguous: baseTerms.length === 0 && retrieval.chunks.length === 0,
  })

  let outcome: Outcome
  if (decision.level === 0) {
    outcome = {status: 'clarification_needed', answer: null, evidenceCount: 0, modelId: null}
  } else if (retrieval.chunks.length === 0) {
    outcome = {status: 'insufficient_evidence', answer: null, evidenceCount: 0, modelId: null}
  } else {
    if (!model) throw new AiCallError('provider_error', 'The tutor model is not configured')
    const answer = await answerTutorQuestion({
      model,
      level: decision.level,
      question: request.question,
      terms,
      lessonTitle: scope.lesson.title,
      currentSeconds: request.currentSeconds,
      chunks: retrieval.chunks,
      timeoutMs,
    })
    outcome = {
      status: answer.status,
      answer,
      evidenceCount: retrieval.chunks.length,
      modelId: typeof model === 'string' ? model : model.modelId,
    }
  }

  try {
    const recorded = await record({db, learnerId, request, instance, lessonId: scope.lesson.id, scope: retrieval.scope, decision, outcome})
    return {status: 'answered', body: respond(recorded, retrieval.scope, decision, outcome)}
  } catch (error) {
    if (error instanceof Rejection) return rejected(error.code)
    throw error
  }
}

type Recorded = {tutorRequestId: string; helpEventId: string | null}

/** tx2: the request row, the help event when help was delivered, and their outbox events, atomically. */
function record({
  db,
  learnerId,
  request,
  instance,
  lessonId,
  scope,
  decision,
  outcome,
}: {
  db: postgres.Sql
  learnerId: string
  request: TutorRequest
  instance: TaskInstanceRow | null
  lessonId: string
  scope: RetrievalScope
  decision: HelpDecision
  outcome: Outcome
}): Promise<Recorded> {
  return asLearner(db, learnerId, async (tx) => {
    // Orders this help against grading on the same family, as `/api/help` does.
    if (instance) await lockLearnerFamily(tx, learnerId, instance.familyId)

    let helpEventId: string | null = null
    if (outcome.status !== 'insufficient_evidence') {
      const inserted = await insertHelpEvent(tx, learnerId, {
        requestKey: request.requestKey,
        taskInstanceId: instance?.id,
        sessionId: request.sessionId,
        level: decision.level,
        explicitOverride: decision.explicitOverride,
        policyVersion: decision.policyVersion,
        reasonCode: decision.reasonCode,
      })
      if (inserted.status !== 'recorded') throw new Rejection('not_found')
      if (inserted.replayed) {
        // A concurrent request with this key committed first.
        throw new Rejection((await tutorRequestExists(tx, learnerId, request.requestKey)) ? 'already_answered' : 'idempotency_key_reused')
      }
      helpEventId = inserted.id
    }

    const [row] = await tx<{id: string}[]>`
      insert into learner.tutor_request
        (learner_id, request_key, lesson_id, task_instance_id, session_id, help_event_id,
         status, scope, evidence_count, cited_count, prompt_version, model_id, current_seconds)
      values
        (${learnerId}, ${request.requestKey}, ${lessonId}, ${instance?.id ?? null}, ${request.sessionId ?? null}, ${helpEventId},
         ${outcome.status}, ${scope}, ${outcome.evidenceCount}, ${outcome.answer?.citedCount ?? 0}, ${TUTOR_PROMPT_VERSION}, ${outcome.modelId},
         ${request.currentSeconds})
      on conflict (learner_id, request_key) do nothing
      returning id
    `
    if (!row) throw new Rejection('already_answered')

    // Ids and enums only: no question, answer, or source text leaves the request path.
    if (helpEventId) {
      await tx`
        insert into learner.event_outbox (event_type, payload)
        values ('help_level_decided', ${tx.json({
          helpEventId,
          learnerId,
          taskInstanceId: instance?.id ?? null,
          familyId: instance?.familyId ?? null,
          sessionId: request.sessionId ?? null,
          level: decision.level,
          reasonCode: decision.reasonCode,
          explicitOverride: decision.explicitOverride,
          policyVersion: decision.policyVersion,
        })})
      `
    }
    await tx`
      insert into learner.event_outbox (event_type, payload)
      values ('tutor_answered', ${tx.json({
        tutorRequestId: row.id,
        learnerId,
        lessonId,
        taskInstanceId: instance?.id ?? null,
        helpEventId,
        status: outcome.status,
        scope,
        evidenceCount: outcome.evidenceCount,
        citedCount: outcome.answer?.citedCount ?? 0,
        droppedStatements: outcome.answer?.dropped.length ?? 0,
        // Model-assisted, not proof; null when no answer was generated.
        supportCheck: outcome.answer ? TUTOR_SUPPORT_PROMPT_VERSION : null,
        promptVersion: TUTOR_PROMPT_VERSION,
      })})
    `
    return {tutorRequestId: row.id, helpEventId}
  })
}

function respond(recorded: Recorded, scope: RetrievalScope, decision: HelpDecision, outcome: Outcome): TutorResponse {
  const help = recorded.helpEventId
    ? {helpEventId: recorded.helpEventId, level: decision.level, reasonCode: decision.reasonCode, policyVersion: decision.policyVersion}
    : null
  const base = {tutorRequestId: recorded.tutorRequestId, status: outcome.status, scope, help}
  if (outcome.status === 'clarification_needed') {
    return tutorResponseSchema.parse({...base, statements: [], followUp: CLARIFYING_QUESTION})
  }
  if (outcome.status === 'insufficient_evidence' || !outcome.answer) {
    return tutorResponseSchema.parse({...base, statements: [], message: INSUFFICIENT_EVIDENCE_MESSAGE})
  }
  const {statements, followUp} = outcome.answer
  return tutorResponseSchema.parse({...base, statements, ...(followUp ? {followUp} : {})})
}
