import {SOLUTION_HELP_LEVEL, type EvidenceKind} from '../learner/evidence.ts'
import type {ExplanationEvidenceReason, ExplanationOutcome} from './contracts.ts'

/**
 * How one explanation counts as evidence (development plan §5 PR-8). Pure:
 * the service supplies facts read from the learner's own history inside the
 * transaction that completes the explanation. Recorded on
 * `explanation_log` only, as its own evidence type: no explanation changes
 * `concept_mastery`, missing points never lower anything, and an unassisted
 * explanation (`independent`) is not independent application of the skill.
 *
 * Precedence:
 * 1. an off-topic text → not counted: nothing was judged;
 * 2. identical text already evaluated on this task → not counted;
 * 3. an earlier assessed explanation of the task → assisted: the learner saw
 *    its feedback, so this is a revision, never the original response;
 * 4. help recorded on the lesson or the task's concepts before → assisted,
 *    with answer exposure once a solution (level 3) was shown;
 * 5. otherwise → the first unassisted explanation.
 */

export type ExplanationFacts = {
  outcome: ExplanationOutcome
  /** This learner already had identical text evaluated for the task (any version). */
  identicalBefore: boolean
  /** Earlier explanations of the task whose criterion feedback the learner saw. */
  priorAssessed: number
  /** Highest help level recorded on the lesson or the task's concepts before this explanation (0 = none). */
  helpLevelBefore: number
}

export type ExplanationEvidence = {kind: EvidenceKind; reason: ExplanationEvidenceReason}

export function classifyExplanation({outcome, identicalBefore, priorAssessed, helpLevelBefore}: ExplanationFacts): ExplanationEvidence {
  if (outcome === 'off_topic') return {kind: 'not_counted', reason: 'not_assessable'}
  if (identicalBefore) return {kind: 'not_counted', reason: 'repeat_submission'}
  if (priorAssessed > 0) return {kind: 'assisted', reason: 'revision_after_feedback'}
  if (helpLevelBefore >= SOLUTION_HELP_LEVEL) return {kind: 'assisted', reason: 'answer_exposed'}
  if (helpLevelBefore > 0) return {kind: 'assisted', reason: 'hint_used'}
  return {kind: 'independent', reason: 'first_independent_response'}
}
