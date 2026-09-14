import type postgres from 'postgres'

import {asLearner} from '../db/learner-scope.ts'
import type {EvidenceReason} from './evidence.ts'

/**
 * Read-only learner evidence for the My Learning overview. Runs under
 * `asLearner`, so row level security confines it to the signed-in learner;
 * both reads are bounded and select ids and enums only.
 */

export const RECENT_ATTEMPT_LIMIT = 3

/** Upper bound on concept ids read for the per-course evidence count. */
export const EVIDENCE_CONCEPT_LIMIT = 500

export type RecentAttempt = {
  lessonId: string
  evidenceReason: EvidenceReason
  createdAt: Date
}

export type LearnerOverviewEvidence = {
  /** The learner's latest graded attempts, newest first. */
  recentAttempts: RecentAttempt[]
  /** Stable concept ids (`cpt-…`) with independent evidence, as recorded at grading time. */
  independentConceptIds: string[]
}

export async function readLearnerOverview(db: postgres.Sql, learnerId: string): Promise<LearnerOverviewEvidence> {
  return asLearner(db, learnerId, async (tx) => {
    const recentAttempts = await tx<RecentAttempt[]>`
      select t.lesson_id as "lessonId", a.evidence_reason as "evidenceReason", a.created_at as "createdAt"
      from learner.attempt_log a
      join learner.task_instance t on t.id = a.task_instance_id
      where a.learner_id = ${learnerId}
      order by a.created_at desc, a.id desc
      limit ${RECENT_ATTEMPT_LIMIT}
    `
    const mastery = await tx<{conceptId: string}[]>`
      select concept_id as "conceptId" from learner.concept_mastery
      where learner_id = ${learnerId} and evidence_status = 'independent'
      order by concept_id
      limit ${EVIDENCE_CONCEPT_LIMIT}
    `
    return {recentAttempts: [...recentAttempts], independentConceptIds: mastery.map((row) => row.conceptId)}
  })
}
