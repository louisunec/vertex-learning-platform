import type postgres from 'postgres'

import {asLearner, type LearnerTx} from '../db/learner-scope.ts'
import {issueTaskResponseSchema, type IssueTaskResponse} from './contracts.ts'
import type {LearnerContentSource} from './content-source.ts'

/**
 * Server-issued task instances (development plan §5 PR-4). An instance pins
 * one learner to one assessment version and the option ids delivered, so a
 * submission is graded against exactly what was shown. `learnerId` is always
 * the Clerk user id from `auth()`.
 */

export const TASK_INSTANCE_TTL_MS = 24 * 60 * 60 * 1000

export type TaskInstanceRow = {
  id: string
  learnerId: string
  assessmentId: string
  familyId: string
  assessmentVersion: number
  lessonId: string
  deliveredOptionIds: string[]
  expiresAt: Date
}

export type IssueTaskOutcome = {status: 'issued'; body: IssueTaskResponse} | {status: 'not_found'}

export async function issueTask({
  db,
  content,
  learnerId,
  assessmentId,
  now,
}: {
  db: postgres.Sql
  content: LearnerContentSource
  learnerId: string
  assessmentId: string
  now: Date
}): Promise<IssueTaskOutcome> {
  const item = await content.loadServableItem(assessmentId)
  if (!item) return {status: 'not_found'}

  const expiresAt = new Date(now.getTime() + TASK_INSTANCE_TTL_MS)
  const [row] = await asLearner(
    db,
    learnerId,
    (tx) => tx<{id: string}[]>`
      insert into learner.task_instance
        (learner_id, assessment_id, family_id, assessment_version, lesson_id, delivered_option_ids, issued_at, expires_at)
      values
        (${learnerId}, ${item._id}, ${item.familyId}, ${item.version}, ${item.lessonId},
         ${tx.array(item.options.map((option) => option.id))}, ${now}, ${expiresAt})
      returning id
    `,
  )
  return {
    status: 'issued',
    body: issueTaskResponseSchema.parse({taskInstanceId: row.id, expiresAt: expiresAt.toISOString(), item}),
  }
}

/**
 * The instance when it exists and belongs to `learnerId`; another learner's
 * instance is indistinguishable from none. Row level security already hides
 * other learners' rows inside `asLearner`; the filter states the intent.
 */
export async function findOwnedTaskInstance(tx: LearnerTx, learnerId: string, id: string): Promise<TaskInstanceRow | null> {
  const [row] = await tx<TaskInstanceRow[]>`
    select
      id,
      learner_id as "learnerId",
      assessment_id as "assessmentId",
      family_id as "familyId",
      assessment_version as "assessmentVersion",
      lesson_id as "lessonId",
      delivered_option_ids as "deliveredOptionIds",
      expires_at as "expiresAt"
    from learner.task_instance
    where id = ${id} and learner_id = ${learnerId}
  `
  return row ?? null
}
