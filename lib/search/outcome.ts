import {createHash} from 'node:crypto'

import {fallbackTerms} from './terms.ts'

/**
 * Classifies one search (its first result page) for editorial "no grounded
 * results" signals (development plan §5 PR-10), so a search that found
 * nothing is never confused with a search that could not run properly.
 *
 * - `results` / `no_results`: retrieval ran over a successfully interpreted
 *   query (by the model, or deterministically because no model is
 *   configured). Only `no_results` is evidence about content, and even then
 *   only that these words matched nothing.
 * - `no_results_degraded`: interpretation fell back to deterministic terms
 *   after a provider error or timeout, and nothing matched; the miss may be
 *   the outage's.
 * - `no_terms`: the query had nothing searchable, so no retrieval ran.
 * - `unavailable`: the Context MCP was down or timed out (HTTP 502).
 * - `failed`: any other error (HTTP 500).
 *
 * The analytics event carries the query's tokenized deterministic terms (at
 * most six short keywords, never the raw query) and their fingerprint.
 */

export type InterpretationMode = 'model' | 'deterministic' | 'fallback_after_error'

export type SearchOutcome = 'results' | 'no_results' | 'no_results_degraded' | 'no_terms' | 'unavailable' | 'failed'

/** Filled in by `searchVertex` for the route's analytics. */
export type SearchDiagnostics = {interpretation?: InterpretationMode; termCount?: number}

export const MAX_OUTCOME_TERMS = 6
const TERM = /^[\p{L}\p{N}][\p{L}\p{N}+#._-]{0,31}$/u

export function classifySearchOutcome(
  input: {error: 'unavailable' | 'failed'} | {total: number; termCount: number; interpretation: InterpretationMode},
): SearchOutcome {
  if ('error' in input) return input.error
  if (input.termCount === 0) return 'no_terms'
  if (input.total > 0) return 'results'
  return input.interpretation === 'fallback_after_error' ? 'no_results_degraded' : 'no_results'
}

/** The query's own deterministic keywords, lowercased, deduplicated, sorted, and bounded: a stable key for "the same search". */
export function outcomeTerms(query: string): string[] {
  return [...new Set(fallbackTerms(query).map((term) => term.toLowerCase()))]
    .filter((term) => TERM.test(term))
    .toSorted()
    .slice(0, MAX_OUTCOME_TERMS)
}

export function termsFingerprint(terms: readonly string[]): string {
  return createHash('sha256').update(terms.join(' ')).digest('hex').slice(0, 16)
}
