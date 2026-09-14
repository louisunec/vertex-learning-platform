/**
 * Which FSRS rating one graded answer is (development plan §5 PR-9,
 * prompts/pr-9-scheduled-review.md). Pure and versioned.
 *
 * Only server-derived facts are inputs: whether the answer was right, and the
 * help recorded on the family before it (`attempt_log.hint_level_used`,
 * `answer_exposed`). Self-confidence is deliberately not a parameter, so it
 * can never become a rating, and neither can an assisted correct answer:
 *
 * | facts                          | decision                     |
 * |--------------------------------|------------------------------|
 * | no help, correct               | Good                         |
 * | no help, incorrect             | Again                        |
 * | help or exposure, incorrect    | Again                        |
 * | help or exposure, correct      | unrated (card left unchanged)|
 *
 * Hard and Easy are never produced. A repeated question (`not_counted` as
 * mastery evidence) is still a valid retention observation, so the mastery
 * evidence kind is not an input either.
 */

export const RATING_POLICY_VERSION = 'rating-v1'

/** ts-fsrs `Rating` values this policy can produce. */
export const AGAIN = 1
export const GOOD = 3

export type RatingFacts = {
  correct: boolean
  /** Highest help level recorded on the family before the answer (0 = none). */
  hintLevelUsed: number
  /** The solution was shown before the answer. */
  answerExposed: boolean
}

export type RatingDecision = {outcome: 'rated'; rating: typeof AGAIN | typeof GOOD} | {outcome: 'unrated_assisted_correct'}

export function decideRating({correct, hintLevelUsed, answerExposed}: RatingFacts): RatingDecision {
  if (!correct) return {outcome: 'rated', rating: AGAIN}
  if (hintLevelUsed > 0 || answerExposed) return {outcome: 'unrated_assisted_correct'}
  return {outcome: 'rated', rating: GOOD}
}
