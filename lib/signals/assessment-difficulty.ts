import type postgres from 'postgres'

import {asSignalsWorker} from '../db/worker-scope.ts'
import {rate, percent, type SignalCandidate} from './candidate.ts'
import type {SignalThresholds} from './config.ts'
import type {SignalWindow} from './windows.ts'

/**
 * Assessment difficulty from the authoritative attempt records
 * (`learner.attempt_log`, PR-4), one aggregate per immutable assessment
 * version per window.
 *
 * Denominator: independent first responses (`evidence_kind =
 * 'independent'`). PR-4 classifies an attempt as independent only when it
 * is the learner's first response to the assessment family and no hint or
 * answer was shown before it, so each learner contributes at most one per
 * family, and `eligible` equals the distinct learners among them. A learner
 * who first answered v1 counts only for v1; a later response to v2 is a
 * retry. Assisted attempts (hint or answer shown) and retries are reported
 * alongside but never enter the error rate.
 *
 * Labelled synthetic learners are excluded. Versions never mix: rows group
 * by the version's own document id.
 */

export type AssessmentAggregate = {
  assessmentId: string
  familyId: string
  version: number
  eligible: number
  eligibleIncorrect: number
  eligibleLearners: number
  assisted: number
  assistedIncorrect: number
  retries: number
  learners: number
  attempts: number
}

export async function readAssessmentAggregates(db: postgres.Sql, window: SignalWindow): Promise<AssessmentAggregate[]> {
  return asSignalsWorker(
    db,
    (tx) => tx<AssessmentAggregate[]>`
      select
        a.assessment_id as "assessmentId",
        a.family_id as "familyId",
        a.assessment_version as "version",
        count(*) filter (where a.evidence_kind = 'independent')::int as "eligible",
        count(*) filter (where a.evidence_kind = 'independent' and not a.correct)::int as "eligibleIncorrect",
        count(distinct a.learner_id) filter (where a.evidence_kind = 'independent')::int as "eligibleLearners",
        count(*) filter (where a.evidence_kind = 'assisted')::int as "assisted",
        count(*) filter (where a.evidence_kind = 'assisted' and not a.correct)::int as "assistedIncorrect",
        count(*) filter (where a.evidence_kind = 'not_counted')::int as "retries",
        count(distinct a.learner_id)::int as "learners",
        count(*)::int as "attempts"
      from learner.attempt_log a
      where a.created_at >= ${window.start} and a.created_at < ${window.end}
        and not exists (select 1 from learner.synthetic_learner s where s.learner_id = a.learner_id)
      group by a.assessment_id, a.family_id, a.assessment_version
      order by a.assessment_id
    `,
  )
}

export function evaluateAssessment(row: AssessmentAggregate, thresholds: SignalThresholds['assessment']): SignalCandidate {
  const errorRate = rate(row.eligibleIncorrect, row.eligible)
  const enough = row.eligible >= thresholds.minEligible
  const thresholdMet = enough && errorRate !== null && errorRate > thresholds.errorRateAbove
  const rule = `Raised when more than ${percent(thresholds.errorRateAbove)} of at least ${thresholds.minEligible} independent first attempts on one assessment version are incorrect.`
  const reason = thresholdMet
    ? `${row.eligibleIncorrect} of ${row.eligible} independent first attempts (${percent(errorRate)}) were incorrect in this window. This can mean the item is hard, ambiguous, or mis-keyed; it is not a verdict.`
    : enough
      ? `${percent(errorRate)} of ${row.eligible} independent first attempts were incorrect, at or below the ${percent(thresholds.errorRateAbove)} threshold.`
      : `Only ${row.eligible} independent first attempts in this window; the rule needs at least ${thresholds.minEligible}.`
  return {
    type: 'assessment_difficulty',
    subjectKey: row.assessmentId,
    thresholdMet,
    reason,
    lessonId: null,
    assessment: {id: row.assessmentId, familyId: row.familyId, version: row.version},
    timestamp: null,
    measurement: {
      numerator: row.eligibleIncorrect,
      numeratorLabel: 'Incorrect independent first attempts',
      denominator: row.eligible,
      denominatorLabel: "Independent first attempts (each learner's first response to this assessment family, delivered as this version, with no hint shown)",
      rate: errorRate,
      distinctLearners: row.eligibleLearners,
    },
    supporting: [
      {key: 'assisted', label: 'Assisted attempts (hint or answer shown; not in the rate)', value: row.assisted},
      {key: 'assisted_incorrect', label: 'Assisted attempts answered incorrectly', value: row.assistedIncorrect},
      {key: 'retries', label: 'Retries (repeat responses; not in the rate)', value: row.retries},
      {key: 'learners', label: 'Distinct learners with any attempt', value: row.learners},
      {key: 'attempts', label: 'All attempts', value: row.attempts},
    ],
    searchTerms: null,
    rule,
  }
}
