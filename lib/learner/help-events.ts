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
 * Choosing the level is the help policy's job (PR-5), which calls this
 * service; PR-4 adds no help route.
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
 * Records one help event for `learnerId`. A task instance must belong to the
 * learner, and its family is taken from the instance, not the caller. A
 * retry with the same `requestKey` returns the first event unchanged, so
 * retrying never escalates help.
 */
export async function recordHelpEvent(db: postgres.Sql, learnerId: string, input: HelpEventInput): Promise<RecordHelpOutcome> {
  const event = helpEventInputSchema.parse(input)

  return asLearner(db, learnerId, async (tx): Promise<RecordHelpOutcome> => {
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
  })
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
