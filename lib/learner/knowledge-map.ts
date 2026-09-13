import type postgres from 'postgres'

import {asLearner} from '../db/learner-scope.ts'
import type {LatestIndependentRow, MasteryRow} from '../knowledge-map.ts'
import type {EvidenceKind, EvidenceReason} from './evidence.ts'

/**
 * Read-only learner evidence for the knowledge map. Runs under `asLearner`,
 * so row level security confines every statement to the signed-in learner.
 * Each read is bounded and selects counts, enums, ids, and times only.
 */

/** Upper bound on mastery rows and per-concept latest attempts read for one map. */
export const MAP_EVIDENCE_LIMIT = 500

/** Attempts shown for the selected concept. */
export const CONCEPT_ATTEMPT_LIMIT = 5

export type MapEvidence = {mastery: MasteryRow[]; latestIndependent: LatestIndependentRow[]}

/** The learner's mastery counts and, per concept, their latest independent response. */
export async function readMapEvidence(db: postgres.Sql, learnerId: string): Promise<MapEvidence> {
  return asLearner(db, learnerId, async (tx) => {
    const mastery = await tx<MasteryRow[]>`
      select concept_id as "conceptId",
             independent_correct as "independentCorrect", independent_incorrect as "independentIncorrect",
             assisted_correct as "assistedCorrect", assisted_incorrect as "assistedIncorrect"
      from learner.concept_mastery
      where learner_id = ${learnerId}
      order by concept_id
      limit ${MAP_EVIDENCE_LIMIT}
    `
    const latestIndependent = await tx<LatestIndependentRow[]>`
      select distinct on (resolved_concept_id)
             resolved_concept_id as "conceptId", correct, created_at as "createdAt"
      from learner.attempt_log
      where learner_id = ${learnerId} and evidence_kind = 'independent' and resolved_concept_id is not null
      order by resolved_concept_id, created_at desc, id desc
      limit ${MAP_EVIDENCE_LIMIT}
    `
    return {mastery: [...mastery], latestIndependent: [...latestIndependent]}
  })
}

export type ConceptAttempt = {
  id: string
  assessmentId: string
  assessmentVersion: number
  selectedOptionId: string
  correct: boolean
  evidenceKind: EvidenceKind
  evidenceReason: EvidenceReason
  createdAt: Date
}

/** The learner's newest attempts recorded against any of `conceptIds` (stable ids), newest first. */
export async function readConceptAttempts(db: postgres.Sql, learnerId: string, conceptIds: string[]): Promise<ConceptAttempt[]> {
  if (conceptIds.length === 0) return []
  return asLearner(db, learnerId, async (tx) => {
    const rows = await tx<ConceptAttempt[]>`
      select id, assessment_id as "assessmentId", assessment_version as "assessmentVersion",
             selected_option_id as "selectedOptionId", correct,
             evidence_kind as "evidenceKind", evidence_reason as "evidenceReason", created_at as "createdAt"
      from learner.attempt_log
      where learner_id = ${learnerId} and resolved_concept_id = any(${tx.array(conceptIds)})
      order by created_at desc, id desc
      limit ${CONCEPT_ATTEMPT_LIMIT}
    `
    return [...rows]
  })
}
