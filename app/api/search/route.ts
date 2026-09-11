import {auth} from '@clerk/nextjs/server'
import {NextRequest, NextResponse} from 'next/server'

import {SearchUnavailableError} from '@/lib/search/mcp'
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

  try {
    // Search stays public; the optional user id only selects flag variants.
    const {userId} = await auth()
    const response = await searchVertex({query, cursor, distinctId: userId ?? 'anonymous'})
    return NextResponse.json(response, {headers: {'Cache-Control': 'no-store'}})
  } catch (error) {
    if (error instanceof SearchUnavailableError) {
      console.error('[search] unavailable:', error.message)
      return NextResponse.json({error: 'Search is temporarily unavailable'}, {status: 502})
    }
    console.error('[search] failed:', error)
    return NextResponse.json({error: 'Search failed'}, {status: 500})
  }
}
