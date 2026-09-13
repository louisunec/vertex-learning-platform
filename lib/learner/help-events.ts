import type postgres from 'postgres'
import {z} from 'zod'

import {asLearner, type LearnerTx} from '../db/learner-scope.ts'
import {IDEMPOTENCY_KEY} from './contracts.ts'
import {SOLUTION_HELP_LEVEL} from './evidence.ts'
import {findOwnedTaskInstance} from './task-instances.ts'

/**
 * Persisted help (development plan §5 PR-4). Help is recorded apart from
 * attempts because a learner can ask for help without answering, and the
 * grader derives the help level from these rows, never from the client.
 * Choosing the level is the help policy's job (PR-5, `help.ts`), which
 * records it with `insertHelpEvent` in the same transaction as its decision.
 */

export const helpEventInputSchema = z.strictObject({
  requestKey: z.string().regex(IDEMPOTENCY_KEY),
  taskInstanceId: z.uuid().optional(),
  sessionId: z.string().min(1).max(128).optional(),
  conceptIds: z.array(z.string().min(1).max(128)).max(8).default([]),
  level: z.number().int().min(0).max(SOLUTION_HELP_LEVEL),
  explicitOverride: z.boolean().default(false),
  policyVersion: z.string().min(1).max(64),
  reasonCode: z.string().min(1).max(64),
})

export type HelpEventInput = z.input<typeof helpEventInputSchema>

export type RecordHelpOutcome =
  | {status: 'recorded'; id: string; level: number; replayed: boolean}
  | {status: 'not_found'}

/**
 * Records one help event for `learnerId` inside `tx`. A task instance must
 * belong to the learner, and its family is taken from the instance, not the
 * caller. A retry with the same `requestKey` returns the first event
 * unchanged, so retrying never escalates help.
 */
export async function insertHelpEvent(tx: LearnerTx, learnerId: string, input: HelpEventInput): Promise<RecordHelpOutcome> {
  const event = helpEventInputSchema.parse(input)

  let familyId: string | null = null
  if (event.taskInstanceId) {
    const instance = await findOwnedTaskInstance(tx, learnerId, event.taskInstanceId)
    if (!instance) return {status: 'not_found'}
    familyId = instance.familyId
  }

  const [inserted] = await tx<{id: string; level: number}[]>`
    insert into learner.help_event
      (learner_id, task_instance_id, session_id, family_id, concept_ids, level, explicit_override, policy_version, reason_code, request_key)
    values
      (${learnerId}, ${event.taskInstanceId ?? null}, ${event.sessionId ?? null}, ${familyId}, ${tx.array(event.conceptIds)},
       ${event.level}, ${event.explicitOverride}, ${event.policyVersion}, ${event.reasonCode}, ${event.requestKey})
    on conflict (learner_id, request_key) do nothing
    returning id, level
  `
  if (inserted) return {status: 'recorded', id: inserted.id, level: inserted.level, replayed: false}

  const [existing] = await tx<{id: string; level: number}[]>`
    select id, level from learner.help_event where learner_id = ${learnerId} and request_key = ${event.requestKey}
  `
  return {status: 'recorded', id: existing.id, level: existing.level, replayed: true}
}

/** `insertHelpEvent` in its own learner-scoped transaction. */
export function recordHelpEvent(db: postgres.Sql, learnerId: string, input: HelpEventInput): Promise<RecordHelpOutcome> {
  return asLearner(db, learnerId, (tx) => insertHelpEvent(tx, learnerId, input))
}

export type StoredHelpEvent = {
  id: string
  taskInstanceId: string | null
  level: number
  reasonCode: string
  policyVersion: string
}

/** The event `learnerId` already recorded under `requestKey`, if any. */
export async function findHelpEventByKey(tx: LearnerTx, learnerId: string, requestKey: string): Promise<StoredHelpEvent | null> {
  const [row] = await tx<StoredHelpEvent[]>`
    select
      id,
      task_instance_id as "taskInstanceId",
      level,
      reason_code as "reasonCode",
      policy_version as "policyVersion"
    from learner.help_event
    where learner_id = ${learnerId} and request_key = ${requestKey}
  `
  return row ?? null
}

/** The highest help level `learnerId` has received on one task instance (0 when none). */
export async function getInstanceHelpLevel(tx: LearnerTx, learnerId: string, taskInstanceId: string): Promise<number> {
  const [row] = await tx<{maxLevel: number}[]>`
    select coalesce(max(level), 0)::int as "maxLevel"
    from learner.help_event
    where learner_id = ${learnerId} and task_instance_id = ${taskInstanceId}
  `
  return row?.maxLevel ?? 0
}

/**
 * The highest help level `learnerId` has received in one tutor session
 * outside any task (0 when none). Task help is scoped to its instance.
 */
export async function getSessionHelpLevel(tx: LearnerTx, learnerId: string, sessionId: string): Promise<number> {
  const [row] = await tx<{maxLevel: number}[]>`
    select coalesce(max(level), 0)::int as "maxLevel"
    from learner.help_event
    where learner_id = ${learnerId} and session_id = ${sessionId} and task_instance_id is null
  `
  return row?.maxLevel ?? 0
}

/**
 * Serializes help and grading for one learner and assessment family until
 * the transaction ends, so a help level and the evidence that depends on it
 * are never decided from the same stale read.
 */
export async function lockLearnerFamily(tx: LearnerTx, learnerId: string, familyId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended(${`${learnerId}:${familyId}`}, 0))`
}

export type HelpState = {maxLevel: number; answerExposed: boolean}

/** The highest help level `learnerId` has received on an assessment family (0 when none). */
export async function getFamilyHelpState(tx: LearnerTx, learnerId: string, familyId: string): Promise<HelpState> {
  const [row] = await tx<{maxLevel: number}[]>`
    select coalesce(max(level), 0)::int as "maxLevel"
    from learner.help_event
    where learner_id = ${learnerId} and family_id = ${familyId}
  `
  const maxLevel = row?.maxLevel ?? 0
  return {maxLevel, answerExposed: maxLevel >= SOLUTION_HELP_LEVEL}
}
