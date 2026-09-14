import 'server-only'

import type {MCPClient} from '@ai-sdk/mcp'

import {FLAGS, isFlagEnabled} from '@/lib/flags'

import {interpretQuery} from './interpret'
import {connectContextMcp, runGroqQuery} from './mcp'
import {
  buildCourseCandidatesQuery,
  buildLessonCandidatesQuery,
  buildVideoCandidatesQuery,
  buildVisualCandidatesQuery,
  LESSON_VIDEO_INDEX_QUERY,
} from './queries'
import {rankCandidates} from './rank'
import {parseCourseCandidates, parseLessonCandidates, parseVideoMomentCandidates} from './retrieve'
import {fallbackTerms} from './terms'
import {
  decodeSearchCursor,
  encodeSearchCursor,
  MAX_CURSOR_OFFSET,
  searchResponseSchema,
  type SearchResponse,
} from './schema'

export const DEFAULT_PAGE_SIZE = 10
export const MAX_PAGE_SIZE = 20
const MAX_QUERY_LENGTH = 200

/**
 * Full search pipeline (ARCHITECTURE.md §6): interpret → grounded MCP/GROQ
 * retrieval → deterministic ranking → canonical Zod validation → bounded page.
 *
 * A cursor reuses the previous interpretation (no LLM call) and advances the
 * offset. The final response is validated against the canonical schema before
 * it leaves the server; an invalid structure throws rather than reaching the UI.
 */
export async function searchVertex({
  query,
  cursor,
  pageSize = DEFAULT_PAGE_SIZE,
  distinctId = 'anonymous',
}: {
  query: string
  cursor?: string | null
  pageSize?: number
  /** Clerk user id or `"anonymous"`; selects feature-flag variants only. */
  distinctId?: string
}): Promise<SearchResponse> {
  const trimmed = query.trim().slice(0, MAX_QUERY_LENGTH)
  const size = Math.min(Math.max(1, pageSize), MAX_PAGE_SIZE)

  const decoded = decodeSearchCursor(cursor)
  const offset = decoded?.offset ?? 0
  // Evaluated alongside interpretation; off (and on any flag error) keeps visual evidence out.
  const visualEnabled = isFlagEnabled(FLAGS.searchVisualEvidence, distinctId)
  // The learner's own words rank at full weight; LLM expansion terms rank
  // reduced. Recomputed deterministically, so cursor pages need no LLM call.
  const primaryTerms = fallbackTerms(trimmed)
  // Interpretation never returns fewer terms than the learner's own words, and
  // cursor terms are never empty, so retrieval is certain when either exists:
  // the MCP handshake and the term-independent lesson-video index then start
  // now and overlap the LLM call. Otherwise they wait for the terms, as before.
  let retrieval = decoded || primaryTerms.length > 0 ? startTermIndependentRetrieval() : null

  let terms: string[]
  let ranked
  try {
    terms = decoded?.terms ?? (trimmed ? await interpretQuery(trimmed, {distinctId}) : [])

    if (terms.length === 0) {
      return searchResponseSchema.parse({
        query: trimmed,
        results: [],
        total: 0,
        courseCount: 0,
        nextCursor: null,
      })
    }

    retrieval ??= startTermIndependentRetrieval()
    const mcp = await retrieval.client
    const [lessonRows, videoRows, courseRows, lessonIndexRows, visualRows] = await Promise.all([
      runGroqQuery(mcp, buildLessonCandidatesQuery(terms)),
      runGroqQuery(mcp, buildVideoCandidatesQuery(terms)),
      runGroqQuery(mcp, buildCourseCandidatesQuery(terms)),
      retrieval.lessonIndexRows,
      visualEnabled.then((enabled) => (enabled ? runGroqQuery(mcp, buildVisualCandidatesQuery(terms)) : [])),
    ])
    ranked = rankCandidates(
      terms,
      primaryTerms,
      [...parseLessonCandidates(lessonRows), ...parseCourseCandidates(courseRows)],
      parseVideoMomentCandidates(videoRows, lessonIndexRows, visualRows),
    )
  } finally {
    // Every path closes a client it opened, early return and failures included;
    // one that never connected has nothing to close.
    if (retrieval) await retrieval.client.then((mcp) => mcp.close()).catch(() => undefined)
  }

  const page = ranked.slice(offset, offset + size)
  const nextOffset = offset + size
  // An offset past the cursor schema's cap would encode a cursor the route
  // rejects as invalid; stop paginating there instead.
  const nextCursor =
    nextOffset < ranked.length && nextOffset <= MAX_CURSOR_OFFSET
      ? encodeSearchCursor({v: 1, terms, offset: nextOffset})
      : null

  // Counted over the full ranked set (not the page slice) so the grounded
  // "across N courses" line stays stable while the learner pages through.
  const courseCount = new Set(
    ranked.map((result) => result.course?.id).filter((id): id is string => Boolean(id)),
  ).size

  return searchResponseSchema.parse({
    query: trimmed,
    results: page,
    total: ranked.length,
    courseCount,
    nextCursor,
  })
}

/**
 * Opens the per-request MCP client and starts the lesson-video index query,
 * which needs no terms. Both promises are marked handled now so a failure
 * while interpretation is still running is never an unhandled rejection;
 * awaiting them later still throws, so MCP failures keep answering 502.
 */
function startTermIndependentRetrieval(): {client: Promise<MCPClient>; lessonIndexRows: Promise<unknown>} {
  const client = connectContextMcp()
  const lessonIndexRows = client.then((mcp) => runGroqQuery(mcp, LESSON_VIDEO_INDEX_QUERY))
  client.catch(() => undefined)
  lessonIndexRows.catch(() => undefined)
  return {client, lessonIndexRows}
}
