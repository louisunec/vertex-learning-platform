import {SOLUTION_HELP_LEVEL, type EvidenceKind} from '../learner/evidence.ts'
import type {SubmissionEvidenceReason} from './contracts.ts'

/**
 * How one submission counts as evidence (development plan §5 PR-12). Pure:
 * the service supplies facts read from the learner's own history inside the
 * transaction that records the submission. Recorded on `submission_log`
 * only: no submission changes `concept_mastery`, because the review is a
 * model's provisional reading, not an independent grade.
 *
 * Precedence:
 * 1. identical code submitted before on this task → not counted;
 * 2. any help on the task (any version) before submitting → assisted, and
 *    answer exposure once corrections (level 3) were shown;
 * 3. an earlier, different submission on the task → not counted: only the
 *    first response to a task can be independent;
 * 4. otherwise → the first independent attempt.
 */

export type SubmissionFacts = {
  /** This learner already submitted this exact normalized code for the task. */
  identicalBefore: boolean
  /** Earlier submissions on the task, any version. */
  priorSubmissions: number
  /** Highest help level recorded on the task before this submission (0 = none). */
  helpLevelBefore: number
}

export type SubmissionEvidence = {kind: EvidenceKind; reason: SubmissionEvidenceReason}

export function classifySubmission({identicalBefore, priorSubmissions, helpLevelBefore}: SubmissionFacts): SubmissionEvidence {
  if (identicalBefore) return {kind: 'not_counted', reason: 'repeat_submission'}
  if (helpLevelBefore >= SOLUTION_HELP_LEVEL) return {kind: 'assisted', reason: 'answer_exposed'}
  if (helpLevelBefore > 0) return {kind: 'assisted', reason: 'hint_used'}
  if (priorSubmissions > 0) return {kind: 'not_counted', reason: 'repeat_task'}
  return {kind: 'independent', reason: 'first_independent_response'}
}
