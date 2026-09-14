import {auth} from '@clerk/nextjs/server'
import {after, NextRequest, NextResponse} from 'next/server'
import {readPostHogCookie} from 'posthog-node'

import {FLAGS, isFlagEnabled} from '@/lib/flags'
import {getPostHogClient} from '@/lib/posthog-server'
import {SearchUnavailableError} from '@/lib/search/mcp'
import {classifySearchOutcome, outcomeTerms, termsFingerprint, type SearchDiagnostics, type SearchOutcome} from '@/lib/search/outcome'
import {decodeSearchCursor} from '@/lib/search/schema'
import {searchVertex} from '@/lib/search/search'

/**
 * Public search endpoint (browsing is public). All AI/MCP work happens
 * server-side; the browser only ever receives the Zod-validated structured
 * response (ARCHITECTURE.md §6). Explicit failure paths, never fabricated
 * results: bad input → 400, MCP unavailable → 502, invalid structure → 500.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const query = params.get('q')?.trim() ?? ''
  const cursor = params.get('cursor')

  if (!query) {
    return NextResponse.json({error: 'Missing search query'}, {status: 400})
  }
  // Reject rather than silently restarting at page 1 (the client would append duplicates).
  if (cursor && !decodeSearchCursor(cursor)) {
    return NextResponse.json({error: 'Invalid cursor'}, {status: 400})
  }

  let userId: string | null = null
  const diagnostics: SearchDiagnostics = {}
  try {
    // Search stays public; the optional user id only selects flag variants.
    userId = (await auth()).userId
    const response = await searchVertex({query, cursor, distinctId: userId ?? 'anonymous', diagnostics})
    if (!cursor) {
      recordOutcome(request, userId, query, {
        outcome: classifySearchOutcome({
          total: response.total,
          termCount: diagnostics.termCount ?? 0,
          interpretation: diagnostics.interpretation ?? 'deterministic',
        }),
        interpretation: diagnostics.interpretation ?? null,
        resultCount: response.total,
      })
    }
    return NextResponse.json(response, {headers: {'Cache-Control': 'no-store'}})
  } catch (error) {
    const unavailable = error instanceof SearchUnavailableError
    if (!cursor) {
      recordOutcome(request, userId, query, {
        outcome: classifySearchOutcome({error: unavailable ? 'unavailable' : 'failed'}),
        interpretation: diagnostics.interpretation ?? null,
        resultCount: null,
      })
    }
    if (unavailable) {
      console.error('[search] unavailable:', error.message)
      return NextResponse.json({error: 'Search is temporarily unavailable'}, {status: 502})
    }
    console.error('[search] failed:', error)
    return NextResponse.json({error: 'Search failed'}, {status: 500})
  }
}

/**
 * Editorial "no grounded results" signals (development plan §5 PR-10):
 * after the response, and only behind the `editorial-signals` flag, captures
 * how the first page of this search went. The event carries the query's
 * tokenized keywords (at most six), never the raw query. The distinct id is
 * the signed-in learner, else the browser's own PostHog id from its cookie,
 * so distinct people can be counted; anonymous people get no profile.
 */
function recordOutcome(
  request: NextRequest,
  userId: string | null,
  query: string,
  outcome: {outcome: SearchOutcome; interpretation: string | null; resultCount: number | null},
) {
  const token = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN
  if (!token) return
  const distinctId = userId ?? readPostHogCookie(request.cookies, token)?.distinctId ?? 'anonymous'
  const terms = outcomeTerms(query)
  after(async () => {
    try {
      // Local evaluation only: an analytics gate must not add a remote /flags request per search.
      if (!(await isFlagEnabled(FLAGS.editorialSignals, distinctId, {localOnly: true}))) return
      const posthog = getPostHogClient()
      posthog.capture({
        distinctId,
        event: 'search_outcome',
        properties: {
          outcome: outcome.outcome,
          interpretation: outcome.interpretation,
          result_count: outcome.resultCount,
          terms,
          terms_fingerprint: termsFingerprint(terms),
          $process_person_profile: userId !== null,
        },
      })
      await posthog.flush()
    } catch (error) {
      console.error('[analytics] search_outcome capture failed:', error instanceof Error ? error.message : error)
    }
  })
}
