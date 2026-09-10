import 'server-only'

import {createMCPClient, type MCPClient} from '@ai-sdk/mcp'

import {dataset, projectId} from '@/sanity/env'

/**
 * Server-side Sanity Context MCP access (ARCHITECTURE.md §10). The browser
 * never talks to this endpoint; credentials stay in the server environment.
 *
 * The slug-scoped URL applies the published `sanity.agentContext` document's
 * `groqFilter`. With no `SANITY_CONTEXT_SLUG` configured, the base URL is used
 * so search works before the Context document exists.
 */

const CONTEXT_API_VERSION = 'v2026-03-03'

/** Raised for MCP connectivity/tool failures so the route can answer 502. */
export class SearchUnavailableError extends Error {}

/** Builds the dataset-scoped Context MCP URL, including its optional context slug. */
export function contextMcpUrl(): string {
  const slug = process.env.SANITY_CONTEXT_SLUG?.trim()
  const base = `https://api.sanity.io/${CONTEXT_API_VERSION}/context/mcp/${projectId}/${dataset}`
  return slug ? `${base}/${encodeURIComponent(slug)}` : base
}

/** One client per request; callers must `close()` in a `finally`. */
export async function connectContextMcp(): Promise<MCPClient> {
  const token = process.env.SANITY_API_READ_TOKEN
  if (!token) {
    throw new SearchUnavailableError('SANITY_API_READ_TOKEN is required for search (Context MCP auth)')
  }
  try {
    return await createMCPClient({
      transport: {
        type: 'http',
        url: contextMcpUrl(),
        headers: {Authorization: `Bearer ${token}`},
      },
    })
  } catch (error) {
    throw new SearchUnavailableError(
      `Could not connect to the Sanity Context MCP: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * Runs one GROQ query through the MCP `groq_query` tool and returns the
 * parsed result rows. Tool results arrive as MCP content blocks (typically
 * stringified JSON in a text block), so parsing is deliberately defensive;
 * anything unusable becomes a `SearchUnavailableError`, never fabricated data.
 */
export async function runGroqQuery(client: MCPClient, query: string): Promise<unknown> {
  let result
  try {
    result = await client.callTool({name: 'groq_query', arguments: {query}})
  } catch (error) {
    throw new SearchUnavailableError(
      `Context MCP groq_query failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (result.isError) {
    const message = extractText(result.content) ?? 'unknown tool error'
    throw new SearchUnavailableError(`Context MCP groq_query returned an error: ${message}`)
  }
  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    return unwrapResult(result.structuredContent)
  }
  const text = extractText(result.content)
  if (text == null) throw new SearchUnavailableError('Context MCP groq_query returned no content')
  try {
    return unwrapResult(JSON.parse(text))
  } catch {
    throw new SearchUnavailableError('Context MCP groq_query returned non-JSON content')
  }
}

/** Extracts and concatenates text blocks from an MCP tool response. */
function extractText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const parts = content
    .filter(
      (block): block is {type: 'text'; text: string} =>
        typeof block === 'object' &&
        block !== null &&
        (block as {type?: unknown}).type === 'text' &&
        typeof (block as {text?: unknown}).text === 'string',
    )
    .map((block) => block.text)
  return parts.length > 0 ? parts.join('') : null
}

/** Some servers wrap rows as `{result: […]}` (Sanity query envelope). */
function unwrapResult(value: unknown): unknown {
  if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'result' in (value as Record<string, unknown>)
  ) {
    return (value as Record<string, unknown>).result
  }
  return value
}
