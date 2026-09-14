import type postgres from 'postgres'

import {asLearner, type LearnerTx} from '../db/learner-scope.ts'
import {goalResponseSchema, type GoalRequest, type GoalResponse} from './next-action-contracts.ts'
import type {NextActionContentSource} from './next-action-source.ts'

/**
 * The learner's current learning goal (PR-11, migration 0005). One row per
 * learner, read and written under `asLearner`, so row level security
 * confines every statement to the signed-in learner. Only a course goal
 * exists; `setLearningGoal` saves one only for a published course.
 * `learnerId` is always the Clerk user id from `auth()`.
 */

export type LearningGoal = {kind: 'course'; courseId: string; setAt: Date}

type GoalRow = {goalKind: 'course'; courseId: string; setAt: Date}

const toGoal = (row: GoalRow): LearningGoal => ({kind: row.goalKind, courseId: row.courseId, setAt: row.setAt})

export async function readGoalTx(tx: LearnerTx, learnerId: string): Promise<LearningGoal | null> {
  const [row] = await tx<GoalRow[]>`
    select goal_kind as "goalKind", course_id as "courseId", set_at as "setAt"
    from learner.learning_goal
    where learner_id = ${learnerId}
  `
  return row ? toGoal(row) : null
}

export async function readGoal(db: postgres.Sql, learnerId: string): Promise<LearningGoal | null> {
  return asLearner(db, learnerId, (tx) => readGoalTx(tx, learnerId))
}

/** Sets (or replaces) the learner's goal to an already validated course. */
export async function saveCourseGoal(db: postgres.Sql, learnerId: string, courseId: string, now: Date): Promise<LearningGoal> {
  return asLearner(db, learnerId, async (tx) => {
    const [row] = await tx<GoalRow[]>`
      insert into learner.learning_goal (learner_id, goal_kind, course_id, set_at, updated_at)
      values (${learnerId}, 'course', ${courseId}, ${now}, ${now})
      on conflict (learner_id) do update
        set goal_kind = excluded.goal_kind,
            course_id = excluded.course_id,
            set_at = case when learning_goal.course_id = excluded.course_id then learning_goal.set_at else excluded.set_at end,
            updated_at = excluded.updated_at
      returning goal_kind as "goalKind", course_id as "courseId", set_at as "setAt"
    `
    return toGoal(row)
  })
}

export type SetGoalOutcome = {status: 'ok'; body: GoalResponse} | {status: 'rejected'; code: 'not_found'}

/**
 * Saves the course the learner chose as their goal, once it is confirmed to
 * be a published course (browsing is public, so every published course is
 * accessible). An unknown or unpublished course is `not_found`, and nothing
 * is written.
 */
export async function setLearningGoal({
  db,
  content,
  learnerId,
  request,
  now,
}: {
  db: postgres.Sql
  content: Pick<NextActionContentSource, 'loadCourse'>
  learnerId: string
  request: GoalRequest
  now: Date
}): Promise<SetGoalOutcome> {
  const course = await content.loadCourse(request.courseId)
  if (!course) return {status: 'rejected', code: 'not_found'}
  const goal = await saveCourseGoal(db, learnerId, course._id, now)
  return {
    status: 'ok',
    body: goalResponseSchema.parse({
      goal: {kind: goal.kind, courseId: goal.courseId, setAt: goal.setAt.toISOString()},
      course: {id: course._id, title: course.title, slug: course.slug},
    }),
  }
}
