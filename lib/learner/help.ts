import type postgres from 'postgres'

import {decideHelpLevel, type HelpLevel} from '../ai/help-policy.ts'
import {hintText, type HintLadder, type HintRungLevel} from '../assessments/hints.ts'
import {asLearner} from '../db/learner-scope.ts'
import {helpResponseSchema, type HelpRequest, type HelpResponse} from './contracts.ts'
import type {LearnerContentSource} from './content-source.ts'
import {SOLUTION_HELP_LEVEL} from './evidence.ts'
import {
  findHelpEventByKey,
  getInstanceHelpLevel,
  insertHelpEvent,
  lockLearnerFamily,
  type StoredHelpEvent,
} from './help-events.ts'
import {findOwnedTaskInstance, matchesDelivery, type TaskInstanceRow} from './task-instances.ts'

/**
 * Help on a known assessment task (development plan §5 PR-5). The policy
 * (`lib/ai/help-policy.ts`) decides the level from the level already
 * recorded on the task instance; the reviewed offline rung for that level is
 * the only hint returned. No model is called.
 *
 * The decision, the `help_event`, and its outbox event commit in one
 * transaction under the same per-(learner, family) lock as grading, so
 * concurrent escalations serialize and an answer submitted meanwhile sees
 * the help. A retry with the same request key returns the stored level and
 * never escalates. The Sanity read happens between the checking and the
 * writing transaction, never while a transaction is open.
 *
 * Help is allowed after the task was answered or expired — it cannot change
 * a stored grade — and it still marks the family as assisted for later
 * attempts.
 */

export type HelpRejection = 'not_found' | 'hint_unavailable' | 'idempotency_key_reused'

export type RequestHelpOutcome =
  | {status: 'helped'; body: HelpResponse; replayed: boolean}
  | {status: 'rejected'; code: HelpRejection}

const rejected = (code: HelpRejection): RequestHelpOutcome => ({status: 'rejected', code})

type Recorded = {event: StoredHelpEvent; replayed: boolean}

/** The response for a recorded event: the rung for its stored level, re-read from the reviewed ladder. */
function helped(instance: TaskInstanceRow, ladder: HintLadder, {event, replayed}: Recorded): RequestHelpOutcome {
  // A key first used for another task instance never returns that task's help.
  if (event.taskInstanceId !== instance.id) return rejected('idempotency_key_reused')
  const level = event.level as HintRungLevel
  const body = helpResponseSchema.parse({
    helpEventId: event.id,
    level,
    reasonCode: event.reasonCode,
    policyVersion: event.policyVersion,
    hint: {
      level,
      text: hintText(ladder, level),
      ...(level === SOLUTION_HELP_LEVEL ? {correctOptionId: ladder.correctOptionId} : {}),
    },
    replayed,
  })
  return {status: 'helped', body, replayed}
}

export async function requestHelp({
  db,
  content,
  learnerId,
  request,
}: {
  db: postgres.Sql
  content: LearnerContentSource
  learnerId: string
  request: HelpRequest
}): Promise<RequestHelpOutcome> {
  const checked = await asLearner(db, learnerId, async (tx) => {
    const instance = await findOwnedTaskInstance(tx, learnerId, request.taskInstanceId)
    if (!instance) return null
    return {instance, stored: await findHelpEventByKey(tx, learnerId, request.requestKey)}
  })
  if (!checked) return rejected('not_found')
  const {instance, stored} = checked
  if (stored && stored.taskInstanceId !== instance.id) return rejected('idempotency_key_reused')

  // Stale, withdrawn, changed, or incomplete material: nothing is recorded and no hint is improvised.
  const ladder = await content.loadHintLadder(instance.assessmentId)
  if (!ladder || !matchesDelivery(ladder, instance)) return rejected('hint_unavailable')
  if (stored) return helped(instance, ladder, {event: stored, replayed: true})

  const recorded = await asLearner(db, learnerId, async (tx): Promise<Recorded | null> => {
    await lockLearnerFamily(tx, learnerId, instance.familyId)

    // A concurrent request with this key committed first.
    const earlier = await findHelpEventByKey(tx, learnerId, request.requestKey)
    if (earlier) return {event: earlier, replayed: true}

    const currentLevel = (await getInstanceHelpLevel(tx, learnerId, instance.id)) as HelpLevel
    const decision = decideHelpLevel({mode: request.mode, request: request.request, currentLevel})
    const inserted = await insertHelpEvent(tx, learnerId, {
      requestKey: request.requestKey,
      taskInstanceId: instance.id,
      level: decision.level,
      explicitOverride: decision.explicitOverride,
      policyVersion: decision.policyVersion,
      reasonCode: decision.reasonCode,
    })
    if (inserted.status !== 'recorded') return null
    if (inserted.replayed) {
      const event = await findHelpEventByKey(tx, learnerId, request.requestKey)
      return event ? {event, replayed: true} : null
    }

    // Ids and enums only: hint text never leaves the request path.
    await tx`
      insert into learner.event_outbox (event_type, payload)
      values ('help_level_decided', ${tx.json({
        helpEventId: inserted.id,
        learnerId,
        taskInstanceId: instance.id,
        familyId: instance.familyId,
        level: decision.level,
        reasonCode: decision.reasonCode,
        explicitOverride: decision.explicitOverride,
        policyVersion: decision.policyVersion,
      })})
    `
    return {
      event: {
        id: inserted.id,
        taskInstanceId: instance.id,
        level: decision.level,
        reasonCode: decision.reasonCode,
        policyVersion: decision.policyVersion,
      },
      replayed: false,
    }
  })
  return recorded ? helped(instance, ladder, recorded) : rejected('not_found')
}
