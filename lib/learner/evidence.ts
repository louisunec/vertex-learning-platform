/**
 * Conservative learner-evidence policy, V1 (development plan §5 PR-4). Pure:
 * the attempt service supplies facts read from the server's own history and
 * persists the result in the same transaction as the attempt.
 *
 * - Only a learner's first response to a distinct reviewed task (assessment
 *   family, any version) can be independent evidence. Repeats add nothing.
 * - Any help on the family before submitting makes the response assisted;
 *   having seen the solution (level 3) is recorded as answer exposure.
 * - Help levels come from recorded `help_event` rows, never from the client.
 * - The estimate is the Beta(1,1) mean over independent evidence. It is an
 *   uncalibrated heuristic, not the probability that a learner has mastered
 *   a concept, and nothing gates on it. Without independent evidence it is
 *   null: missing evidence stays unknown.
 */

export const EVIDENCE_POLICY_VERSION = 'evidence-v1'

/** Optional self-confidence collected at submission, before correctness feedback. */
export const CONFIDENCE_SIGNAL = 'pre_feedback_1to5_v1'

/** Help level at which the solution has been shown. */
export const SOLUTION_HELP_LEVEL = 3

export const EVIDENCE_KINDS = ['independent', 'assisted', 'not_counted'] as const
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number]

export const EVIDENCE_REASONS = ['first_independent_response', 'hint_used', 'answer_exposed', 'repeat_task'] as const
export type EvidenceReason = (typeof EVIDENCE_REASONS)[number]

export type EvidenceFacts = {
  /** Earlier graded attempts by this learner on the same assessment family. */
  priorFamilyAttempts: number
  /** Highest recorded help level for this learner on the family before submitting (0 = none). */
  helpLevelUsed: number
}

export type EvidenceClassification = {kind: EvidenceKind; reason: EvidenceReason}

/** Classifies one graded response. Precedence: repeat, then solution exposure, then hints. */
export function classifyEvidence({priorFamilyAttempts, helpLevelUsed}: EvidenceFacts): EvidenceClassification {
  if (priorFamilyAttempts > 0) return {kind: 'not_counted', reason: 'repeat_task'}
  if (helpLevelUsed >= SOLUTION_HELP_LEVEL) return {kind: 'assisted', reason: 'answer_exposed'}
  if (helpLevelUsed > 0) return {kind: 'assisted', reason: 'hint_used'}
  return {kind: 'independent', reason: 'first_independent_response'}
}

export type MasteryCounts = {
  independentCorrect: number
  independentIncorrect: number
  assistedCorrect: number
  assistedIncorrect: number
}

export const EMPTY_COUNTS: MasteryCounts = {
  independentCorrect: 0,
  independentIncorrect: 0,
  assistedCorrect: 0,
  assistedIncorrect: 0,
}

/** Adds one classified response to the counts. `not_counted` changes nothing. */
export function applyEvidence(counts: MasteryCounts, kind: EvidenceKind, correct: boolean): MasteryCounts {
  switch (kind) {
    case 'independent':
      return correct
        ? {...counts, independentCorrect: counts.independentCorrect + 1}
        : {...counts, independentIncorrect: counts.independentIncorrect + 1}
    case 'assisted':
      return correct
        ? {...counts, assistedCorrect: counts.assistedCorrect + 1}
        : {...counts, assistedIncorrect: counts.assistedIncorrect + 1}
    case 'not_counted':
      return counts
  }
}

export type EvidenceStatus = 'unknown' | 'assisted_only' | 'independent'

export type MasteryProjection = {estimate: number | null; evidenceStatus: EvidenceStatus}

/** Estimate (4 decimal places, matching the stored `numeric(5,4)`) and evidence status. */
export function projectMastery(counts: MasteryCounts): MasteryProjection {
  const independent = counts.independentCorrect + counts.independentIncorrect
  if (independent > 0) {
    const mean = (1 + counts.independentCorrect) / (2 + independent)
    return {estimate: Math.round(mean * 10_000) / 10_000, evidenceStatus: 'independent'}
  }
  const assisted = counts.assistedCorrect + counts.assistedIncorrect
  return {estimate: null, evidenceStatus: assisted > 0 ? 'assisted_only' : 'unknown'}
}
