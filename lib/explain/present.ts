import type {CriterionStatus, ExplainResponse} from './contracts.ts'

/**
 * Learner-facing wording for explain-back feedback (development plan §5
 * PR-8). Pure and client-safe so the copy rules are unit-tested: nothing
 * here shows a score, a percentage, or "mastered", and "not mentioned",
 * "unclear", and "not settled by the course" never read as "wrong". A point
 * the server could not validate reads as unchecked feedback: never as the
 * learner's unclear wording, nor as the course lacking evidence.
 */

export type FeedbackSummary = {kind: 'off_topic' | 'contradiction' | 'gaps' | 'covered' | 'not_validated' | 'not_judged'; title: string; detail: string}

export function summarizeFeedback(response: Pick<ExplainResponse, 'outcome' | 'criteria'>): FeedbackSummary {
  if (response.outcome === 'off_topic') {
    return {
      kind: 'off_topic',
      title: "This doesn't answer the question yet",
      detail: "Nothing was judged. Try explaining the idea in the question in your own words; there's no penalty for trying again.",
    }
  }
  const required = response.criteria.filter((criterion) => criterion.required)
  const count = (statuses: CriterionStatus[]) => required.filter((criterion) => statuses.includes(criterion.status)).length
  const contradicted = count(['contradicted'])
  if (contradicted > 0) {
    return {
      kind: 'contradiction',
      title: contradicted === 1 ? "One point doesn't match the lesson" : `${contradicted} points don't match the lesson`,
      detail: 'See what the lesson says below, then revise your explanation.',
    }
  }
  if (count(['missing', 'unclear']) > 0) {
    return {
      kind: 'gaps',
      title: 'Some key points to add or clarify',
      detail: "Not mentioning something isn't counted as a mistake. Add what's missing and try again if you like.",
    }
  }
  if (count(['demonstrated']) === required.length) {
    return {
      kind: 'covered',
      title: 'Your explanation covers the key points',
      detail: "That's an AI model's reading of your words against this lesson, not a grade.",
    }
  }
  if (count(['not_validated']) > 0) {
    return {
      kind: 'not_validated',
      title: "Some of this feedback couldn't be checked",
      detail: "Those parts aren't judged either way. You can send your explanation again, or compare it with the lesson moments below.",
    }
  }
  return {
    kind: 'not_judged',
    title: "The lesson material couldn't settle this one",
    detail: "Nothing here is marked wrong. The notes below say which parts couldn't be judged.",
  }
}

export const STATUS_TEXT: Record<CriterionStatus, string> = {
  demonstrated: 'You explained this',
  missing: 'Not covered yet',
  unclear: 'Could be clearer',
  contradicted: "Doesn't match the lesson",
  insufficient_evidence: 'Not settled by the lesson',
  not_validated: "Couldn't be checked",
}

/** An optional point that was not covered is an extra, not a gap. */
export function statusText(criterion: {status: CriterionStatus; required: boolean}): string {
  return !criterion.required && criterion.status === 'missing' ? 'Optional extra' : STATUS_TEXT[criterion.status]
}

export function evidenceNote(attempt: ExplainResponse['attempt']): string | null {
  switch (attempt.evidence.reason) {
    case 'revision_after_feedback':
      return 'This is a revision after feedback, so it is recorded separately from your first explanation.'
    case 'repeat_submission':
      return 'You sent this exact explanation before, so this is the same feedback.'
    case 'hint_used':
    case 'answer_exposed':
      return 'You had help on this lesson before, so this is recorded as explained with help.'
    default:
      return null
  }
}
