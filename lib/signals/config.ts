/**
 * Editorial signal types and their investigation thresholds (development
 * plan §5 PR-10). Thresholds are configurable heuristics that prompt a
 * review, never defect verdicts; each stored signal records the rule text
 * and version it was evaluated under.
 */

export const SIGNAL_TYPES = ['assessment_difficulty', 'replay_hotspot', 'search_no_results', 'tutor_insufficient_evidence'] as const
export type SignalType = (typeof SIGNAL_TYPES)[number]

/** Where each type's source rows come from. */
export const SIGNAL_SOURCES: Record<SignalType, 'postgres' | 'posthog'> = {
  assessment_difficulty: 'postgres',
  tutor_insufficient_evidence: 'postgres',
  replay_hotspot: 'posthog',
  search_no_results: 'posthog',
}

export const SIGNAL_RULES_VERSION = 'signals-v1'

export type SignalThresholds = {
  assessment: {minEligible: number; errorRateAbove: number}
  tutor: {minLearners: number}
  search: {minPeople: number}
  replay: {minPeople: number; minShareOfViewers: number; bucketSeconds: number}
}

export const DEFAULT_THRESHOLDS: SignalThresholds = {
  // The plan's trigger: more than 60% errors over at least 20 independent first attempts.
  assessment: {minEligible: 20, errorRateAbove: 0.6},
  tutor: {minLearners: 3},
  search: {minPeople: 3},
  replay: {minPeople: 5, minShareOfViewers: 0.2, bucketSeconds: 30},
}

/** Neutral titles: what was observed, never a judgement of the content. */
export const SIGNAL_TITLES: Record<SignalType, string> = {
  assessment_difficulty: 'High first-attempt error rate',
  replay_hotspot: 'Repeated replays',
  search_no_results: 'Searches with no grounded results',
  tutor_insufficient_evidence: 'Tutor found insufficient supporting material',
}
