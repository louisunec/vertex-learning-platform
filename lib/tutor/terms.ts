import {contentTerms} from '../ai/tutor.ts'
import {MAX_TERMS, tokenize} from '../search/terms.ts'

/**
 * Deterministic retrieval terms for a tutor question (PR-6 follow-up 2).
 * The learner's topic words, plus a fixed word list for pros-and-cons
 * questions: transcripts and chapter labels teach downsides as "Pros and
 * Cons", "Limitations", or "Disadvantages of …" (23 of the 440 chapter
 * labels in the published dataset, 2026-09-13), words a learner asking about
 * "downsides" does not use. No model is involved: a `tutor-terms-v1` model
 * expansion was compared on the nine evaluation cases and removed
 * (`docs/evals/pr-6-tutor-comparison.md`).
 *
 * List words are constants that already fit the GROQ term shape, so they
 * skip `contentTerms`, which would stem `cons` to `con` (and `con*` matches
 * "context"). `pros`/`cons` come first in their group because chapter labels
 * use them; `pro`/`con` are never used (`pro*` matches "probability").
 */

export const TERM_GROUPS: ReadonlyArray<readonly string[]> = [
  ['cons', 'downside', 'drawback', 'disadvantage', 'limitation', 'weakness', 'pitfall'],
  ['pros', 'advantage', 'benefit', 'upside', 'strength'],
]
/** List words a question can add. */
export const MAX_LIST_TERMS = 4
/** Room kept for the learner's own terms before other terms are added. */
export const MAX_BASE_TERMS = 8

/** A question token names a list word: equal, or its plural ("downsides", "weaknesses"). */
const names = (token: string, word: string) => token === word || token === `${word}s` || token === `${word}es`

/** Other words of every group the question names, in list order, at most `MAX_LIST_TERMS`. */
export function listTerms(question: string): string[] {
  const tokens = tokenize(question)
  const added: string[] = []
  for (const group of TERM_GROUPS) {
    if (!group.some((word) => tokens.some((token) => names(token, word)))) continue
    for (const word of group) {
      if (tokens.some((token) => names(token, word)) || added.includes(word)) continue
      added.push(word)
    }
  }
  return added.slice(0, MAX_LIST_TERMS)
}

/**
 * The learner's terms, then list words, without duplicates, at most
 * `MAX_TERMS`. The learner's terms are cut to `MAX_BASE_TERMS` only as far
 * as needed to make room for list words.
 */
export function mergeTerms(baseTerms: readonly string[], list: readonly string[]): string[] {
  const added = [...new Set(list)].filter((term) => !baseTerms.includes(term))
  const room = Math.max(MAX_BASE_TERMS, MAX_TERMS - added.length)
  return [...new Set([...baseTerms.slice(0, room), ...added])].slice(0, MAX_TERMS)
}

/** Retrieval terms without a model call. `baseTerms` are the learner's own words (strong-match test). */
export function deterministicTerms(question: string): {baseTerms: string[]; terms: string[]} {
  const baseTerms = contentTerms(question)
  // A question with no topic words stays on the window, list words included.
  return {baseTerms, terms: baseTerms.length === 0 ? [] : mergeTerms(baseTerms, listTerms(question))}
}
