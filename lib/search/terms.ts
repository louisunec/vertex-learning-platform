/**
 * Deterministic term handling for search. Pure and framework-free so it can
 * be unit-tested and shared by interpretation, retrieval, and ranking.
 *
 * Every term that reaches a GROQ query passes through `sanitizeTerms`:
 * lowercase `[a-z0-9-]` tokens only, bounded count and length. That makes
 * injecting into an inlined GROQ string literal impossible by construction.
 */

export const MAX_TERMS = 12
const MIN_TERM_LENGTH = 2
const MAX_TERM_LENGTH = 32

/** Query filler that would only produce broad noise (SEARCH.md §5). */
export const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'about', 'an', 'and', 'any', 'are', 'at', 'be', 'best', 'can', 'do',
  'does', 'explain', 'find', 'for', 'from', 'get', 'how', 'i', 'in', 'is',
  'it', 'learn', 'me', 'my', 'of', 'on', 'or', 'part', 'show', 'teach',
  'that', 'the', 'to', 'topic', 'use', 'using', 'video', 'want', 'we',
  'what', 'when', 'where', 'which', 'who', 'why', 'with', 'you',
  // Everything here is a course/lesson, so these match everything.
  'course', 'courses', 'lesson', 'lessons', 'class', 'tutorial',
])

/** Lowercased `[a-z0-9-]` tokens of bounded length, deduplicated in order. */
export function tokenize(input: string): string[] {
  const seen = new Set<string>()
  const tokens: string[] = []
  for (const raw of input.toLowerCase().split(/[^a-z0-9-]+/)) {
    const token = raw.replace(/^-+|-+$/g, '')
    if (token.length < MIN_TERM_LENGTH || token.length > MAX_TERM_LENGTH) continue
    if (seen.has(token)) continue
    seen.add(token)
    tokens.push(token)
  }
  return tokens
}

/** Sanitizes candidate terms (e.g. model output) to safe, bounded tokens. */
export function sanitizeTerms(candidates: ReadonlyArray<unknown>): string[] {
  const seen = new Set<string>()
  const terms: string[] = []
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    for (const token of tokenize(candidate)) {
      if (seen.has(token)) continue
      seen.add(token)
      terms.push(token)
      if (terms.length >= MAX_TERMS) return terms
    }
  }
  return terms
}

/**
 * Deterministic fallback interpretation used when the LLM is unavailable or
 * returns unusable output. Retrieval stays grounded either way; only keyword
 * quality degrades. Falls back to raw tokens when stopword removal empties
 * the query (e.g. a query made only of filler words).
 */
export function fallbackTerms(query: string): string[] {
  const tokens = tokenize(query)
  const meaningful = tokens.filter((token) => !STOPWORDS.has(token))
  return (meaningful.length > 0 ? meaningful : tokens).slice(0, MAX_TERMS)
}

/** Number of terms that appear (prefix match, case-insensitive) in `text`. */
export function countTermHits(text: string | null | undefined, terms: ReadonlyArray<string>): number {
  if (!text) return 0
  const tokens = new Set(tokenize(text))
  let hits = 0
  for (const term of terms) {
    if (tokens.has(term)) {
      hits++
      continue
    }
    for (const token of tokens) {
      if (token.startsWith(term)) {
        hits++
        break
      }
    }
  }
  return hits
}
