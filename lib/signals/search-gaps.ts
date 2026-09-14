import {rate, type SignalCandidate} from './candidate.ts'
import type {SignalThresholds} from './config.ts'
import type {AnalyticsEvent} from './posthog-reader.ts'

/**
 * Searches that found no grounded results, from the server-side
 * `search_outcome` event (`app/api/search/route.ts`, first pages only),
 * grouped by the fingerprint of the query's tokenized deterministic terms.
 *
 * Only `no_results` counts: retrieval ran over a successfully interpreted
 * query and nothing matched. Everything that is not evidence about content
 * is excluded and reported separately: `no_results_degraded` (query
 * interpretation fell back after a provider error or timeout),
 * `unavailable` (MCP down or timed out), `failed`, and `no_terms` (nothing
 * searchable in the query). "Not retrieved" is never proof that the course
 * does not cover a topic.
 */

export const SEARCH_OUTCOME_PROPERTIES = ['outcome', 'interpretation', 'terms_fingerprint', 'terms', 'result_count'] as const

export const EXCLUDED_SEARCH_OUTCOMES = ['no_results_degraded', 'unavailable', 'failed', 'no_terms'] as const

const TERM = /^[\p{L}\p{N}][\p{L}\p{N}+#._-]{0,31}$/u
const MAX_TERMS = 6
const FINGERPRINT = /^[0-9a-f]{16}$/

/** PostHog returns array properties as JSON text through HogQL; fixtures carry arrays. */
function readTerms(value: unknown): string[] | null {
  let list = value
  if (typeof value === 'string') {
    try {
      list = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_TERMS) return null
  return list.every((term) => typeof term === 'string' && TERM.test(term)) ? (list as string[]) : null
}

export type SearchGapReport = {
  candidates: SignalCandidate[]
  total: number
  excluded: Record<(typeof EXCLUDED_SEARCH_OUTCOMES)[number], number>
}

export function aggregateSearchGaps(events: AnalyticsEvent[], thresholds: SignalThresholds['search']): SearchGapReport {
  const excluded = {no_results_degraded: 0, unavailable: 0, failed: 0, no_terms: 0}
  const seen = new Set<string>()
  const groups = new Map<string, {searches: number; withResults: number; noResults: number; people: Set<string>; terms: string[] | null; excludedHere: number}>()

  for (const event of events) {
    if (seen.has(event.uuid)) continue
    seen.add(event.uuid)
    const outcome = String(event.properties.outcome ?? '')
    if ((EXCLUDED_SEARCH_OUTCOMES as readonly string[]).includes(outcome)) excluded[outcome as keyof typeof excluded]++
    const fingerprint = String(event.properties.terms_fingerprint ?? '')
    if (!FINGERPRINT.test(fingerprint)) continue
    const group = groups.get(fingerprint) ?? {searches: 0, withResults: 0, noResults: 0, people: new Set(), terms: null, excludedHere: 0}
    group.searches++
    if (outcome === 'results') group.withResults++
    if (outcome === 'no_results') {
      group.noResults++
      group.people.add(event.personId)
      group.terms ??= readTerms(event.properties.terms)
    }
    if ((EXCLUDED_SEARCH_OUTCOMES as readonly string[]).includes(outcome)) group.excludedHere++
    groups.set(fingerprint, group)
  }

  const rule = `Raised when at least ${thresholds.minPeople} distinct people get no grounded results for the same search terms in the window. Interpretation fallbacks, outages, and failures are excluded.`
  const candidates: SignalCandidate[] = []
  for (const [fingerprint, group] of groups) {
    if (group.noResults === 0) continue
    const thresholdMet = group.people.size >= thresholds.minPeople
    candidates.push({
      type: 'search_no_results',
      subjectKey: fingerprint,
      thresholdMet,
      reason: thresholdMet
        ? `${group.people.size} people searched for the same terms and retrieval found no matching lesson or video moment. The course may still cover the topic under other words; this is a prompt to check.`
        : `${group.people.size} person(s) got no results for these terms; the rule needs ${thresholds.minPeople}.`,
      lessonId: null,
      assessment: null,
      timestamp: null,
      measurement: {
        numerator: group.noResults,
        numeratorLabel: 'Searches with no grounded results',
        denominator: group.searches,
        denominatorLabel: 'Searches with these terms (first result pages)',
        rate: rate(group.noResults, group.searches),
        distinctLearners: group.people.size,
      },
      supporting: [
        {key: 'with_results', label: 'Searches with these terms that returned results', value: group.withResults},
        {key: 'excluded_failures', label: 'Searches with these terms excluded as degraded, unavailable, or failed', value: group.excludedHere},
      ],
      // Shown only on raised signals, where at least `minPeople` people share them.
      searchTerms: thresholdMet ? group.terms : null,
      rule,
    })
  }
  return {candidates, total: seen.size, excluded}
}
