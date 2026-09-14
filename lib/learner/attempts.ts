import {createHash} from 'node:crypto'

import type postgres from 'postgres'

import {resolveConcept, type ConceptResolution} from '../concepts/resolve.ts'
import {asLearner, type LearnerTx} from '../db/learner-scope.ts'
import {readScheduleForAttempt, recordReviewObservation, type ScheduleOutcome} from '../review/cards.ts'
import {attemptResultSchema, type AttemptResult, type SubmitAttemptRequest} from './contracts.ts'
import type {LearnerContentSource} from './content-source.ts'
import {
  applyEvidence,
  classifyEvidence,
  CONFIDENCE_SIGNAL,
  EVIDENCE_POLICY_VERSION,
  projectMastery,
  type EvidenceKind,
  type EvidenceReason,
  type MasteryCounts,
} from './evidence.ts'
import {getFamilyHelpState, getTaskHelpState, lockLearnerFamily} from './help-events.ts'
import {findOwnedTaskInstance, matchesDelivery, type TaskInstanceRow} from './task-instances.ts'

/**
 * Server-side grading of one submission (development plan §5 PR-4).
 *
 * The attempt, its concept-evidence projection update, and its outbox event
 * commit in one transaction. A per-(learner, family) advisory lock makes the
 * "first response to this task" check race-free, and unique indexes on the
 * idempotency key and the task instance make retries and concurrent
 * duplicates return the first result without adding evidence again.
 *
 * Every query runs in `asLearner`, so row level security confines it to the
 * caller's rows. The Sanity read happens between the checking and the
 * writing transaction, never while a transaction is open.
 */

export type SubmitRejection =
  | 'not_found'
  | 'expired'
  | 'invalid_option'
  | 'task_unavailable'
  | 'already_submitted'
  | 'idempotency_key_reused'

export type SubmitAttemptOutcome =
  | {status: 'graded'; body: AttemptResult; replayed: boolean}
  | {status: 'rejected'; code: SubmitRejection}

const rejected = (code: SubmitRejection): SubmitAttemptOutcome => ({status: 'rejected', code})

/** Fingerprint of what a submission asserts, so a reused idempotency key with a different body is detectable. */
export function hashAttemptRequest(request: SubmitAttemptRequest): string {
  const canonical = JSON.stringify([request.taskInstanceId, request.optionId, request.selfConfidence ?? null])
  return createHash('sha256').update(canonical).digest('hex')
}

type StoredAttempt = {
  id: string
  taskInstanceId: string
  correct: boolean
  evidenceKind: EvidenceKind
  evidenceReason: EvidenceReason
  requestHash: string
}

function toResult(row: StoredAttempt, schedule: ScheduleOutcome | null = null): AttemptResult {
  return attemptResultSchema.parse({
    attemptId: row.id,
    taskInstanceId: row.taskInstanceId,
    correct: row.correct,
    evidence: {kind: row.evidenceKind, reasonCode: row.evidenceReason},
    ...(schedule
      ? {schedule: schedule.status === 'scheduled' ? {status: 'scheduled', dueAt: schedule.dueAt.toISOString()} : schedule}
      : {}),
  })
}

/**
 * The stored result for a reused key, a key-reuse rejection, or null when the
 * key is new. A replay returns the schedule the first request recorded, if
 * any, and records nothing more.
 */
async function replayByKey(tx: LearnerTx, learnerId: string, key: string, requestHash: string): Promise<SubmitAttemptOutcome | null> {
  const [row] = await tx<StoredAttempt[]>`
    select
      id,
      task_instance_id as "taskInstanceId",
      correct,
      evidence_kind as "evidenceKind",
      evidence_reason as "evidenceReason",
      request_hash as "requestHash"
    from learner.attempt_log
    where learner_id = ${learnerId} and idempotency_key = ${key}
  `
  if (!row) return null
  if (row.requestHash !== requestHash) return rejected('idempotency_key_reused')
  return {status: 'graded', body: toResult(row, await readScheduleForAttempt(tx, row.id)), replayed: true}
}

type MasteryRow = MasteryCounts

async function updateMastery(tx: LearnerTx, learnerId: string, conceptId: string, kind: EvidenceKind, correct: boolean) {
  await tx`
    insert into learner.concept_mastery (learner_id, concept_id, evidence_status, policy_version)
    values (${learnerId}, ${conceptId}, 'unknown', ${EVIDENCE_POLICY_VERSION})
    on conflict (learner_id, concept_id) do nothing
  `
  const [current] = await tx<MasteryRow[]>`
    select
      independent_correct as "independentCorrect",
      independent_incorrect as "independentIncorrect",
      assisted_correct as "assistedCorrect",
      assisted_incorrect as "assistedIncorrect"
    from learner.concept_mastery
    where learner_id = ${learnerId} and concept_id = ${conceptId}
    for update
  `
  const counts = applyEvidence(current, kind, correct)
  const {estimate, evidenceStatus} = projectMastery(counts)
  await tx`
    update learner.concept_mastery set
      independent_correct = ${counts.independentCorrect},
      independent_incorrect = ${counts.independentIncorrect},
      assisted_correct = ${counts.assistedCorrect},
      assisted_incorrect = ${counts.assistedIncorrect},
      estimate = ${estimate},
      evidence_status = ${evidenceStatus},
      policy_version = ${EVIDENCE_POLICY_VERSION},
      updated_at = now()
    where learner_id = ${learnerId} and concept_id = ${conceptId}
  `
}

export async function submitAttempt({
  db,
  content,
  learnerId,
  request,
  now,
  scheduling = false,
}: {
  db: postgres.Sql
  content: LearnerContentSource
  learnerId: string
  request: SubmitAttemptRequest
  now: Date
  /** `scheduled-review` is on: the answer also updates the learner's review card, in the same transaction (PR-9). */
  scheduling?: boolean
}): Promise<SubmitAttemptOutcome> {
  const requestHash = hashAttemptRequest(request)
  const checked = await asLearner(db, learnerId, async (tx): Promise<SubmitAttemptOutcome | TaskInstanceRow> => {
    const replay = await replayByKey(tx, learnerId, request.idempotencyKey, requestHash)
    if (replay) return replay

    const instance = await findOwnedTaskInstance(tx, learnerId, request.taskInstanceId)
    if (!instance) return rejected('not_found')
    const [submitted] = await tx`select 1 from learner.attempt_log where task_instance_id = ${instance.id}`
    // Under READ COMMITTED each statement sees a fresh snapshot: a duplicate of this request can
    // commit after the key lookup above missed it. Look again before calling the task answered.
    if (submitted) return (await replayByKey(tx, learnerId, request.idempotencyKey, requestHash)) ?? rejected('already_submitted')
    if (instance.expiresAt.getTime() <= now.getTime()) return rejected('expired')
    if (!instance.deliveredOptionIds.includes(request.optionId)) return rejected('invalid_option')
    return instance
  })
  if ('status' in checked) return checked
  const instance = checked

  const item = await content.loadGradingItem(instance.assessmentId)
  if (!item || !matchesDelivery(item, instance)) return rejected('task_unavailable')

  const concept: ConceptResolution | null = item.primaryConceptRef
    ? resolveConcept(item.primaryConceptRef, await content.loadConceptIndex())
    : null
  const conceptId = concept?.status === 'active' ? concept.conceptId : null
  const correct = request.optionId === item.correctOptionId

  const body = await asLearner(db, learnerId, async (tx): Promise<AttemptResult | null> => {
    await lockLearnerFamily(tx, learnerId, instance.familyId)

    const [prior] = await tx<{count: number}[]>`
      select count(*)::int as count from learner.attempt_log
      where learner_id = ${learnerId} and family_id = ${instance.familyId}
    `
    const help = await getFamilyHelpState(tx, learnerId, instance.familyId)
    const evidence = classifyEvidence({priorFamilyAttempts: prior.count, helpLevelUsed: help.maxLevel})

    const [attempt] = await tx<StoredAttempt[]>`
      insert into learner.attempt_log (
        learner_id, task_instance_id, assessment_id, family_id, assessment_version,
        selected_option_id, correct, hint_level_used, answer_exposed,
        self_confidence, confidence_signal, evidence_kind, evidence_reason,
        primary_concept_ref, resolved_concept_id, concept_resolution,
        policy_version, idempotency_key, request_hash
      ) values (
        ${learnerId}, ${instance.id}, ${instance.assessmentId}, ${instance.familyId}, ${instance.assessmentVersion},
        ${request.optionId}, ${correct}, ${help.maxLevel}, ${help.answerExposed},
        ${request.selfConfidence ?? null}, ${request.selfConfidence === undefined ? null : CONFIDENCE_SIGNAL},
        ${evidence.kind}, ${evidence.reason},
        ${item.primaryConceptRef}, ${conceptId}, ${concept?.status ?? 'none'},
        ${EVIDENCE_POLICY_VERSION}, ${request.idempotencyKey}, ${requestHash}
      )
      on conflict do nothing
      returning
        id,
        task_instance_id as "taskInstanceId",
        correct,
        evidence_kind as "evidenceKind",
        evidence_reason as "evidenceReason",
        request_hash as "requestHash"
    `
    // A concurrent request with this key, or for this instance, committed first.
    if (!attempt) return null

    if (conceptId && evidence.kind !== 'not_counted') {
      await updateMastery(tx, learnerId, conceptId, evidence.kind, correct)
    }
    // A repeat adds no mastery evidence but is still a retention observation, so every graded
    // answer with an active concept reaches the card, rated from help facts only. A first answer
    // uses the family's help, as its evidence does; a repeat only the help on this task, since
    // feedback after the earlier answer would otherwise leave the question unratable for good.
    let schedule: ScheduleOutcome | null = null
    if (scheduling && conceptId) {
      const ratingHelp = prior.count > 0 ? await getTaskHelpState(tx, learnerId, instance.id) : help
      schedule = await recordReviewObservation(tx, learnerId, {
        attemptId: attempt.id,
        conceptId,
        taskType: item.type,
        correct,
        hintLevelUsed: ratingHelp.maxLevel,
        answerExposed: ratingHelp.answerExposed,
        now,
      })
    }
    await tx`
      insert into learner.event_outbox (event_type, payload)
      values ('attempt_graded', ${tx.json({
        attemptId: attempt.id,
        learnerId,
        assessmentId: instance.assessmentId,
        familyId: instance.familyId,
        assessmentVersion: instance.assessmentVersion,
        conceptId,
        correct,
        evidenceKind: evidence.kind,
        evidenceReason: evidence.reason,
        policyVersion: EVIDENCE_POLICY_VERSION,
      })})
    `
    return toResult(attempt, schedule)
  })

  if (body) return {status: 'graded', body, replayed: false}
  const replay = await asLearner(db, learnerId, (tx) => replayByKey(tx, learnerId, request.idempotencyKey, requestHash))
  return replay ?? rejected('already_submitted')
}
