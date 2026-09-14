import type {CaptureEvent} from './projection.ts'

/**
 * Delivers outbox events to PostHog's public batch capture endpoint
 * (`POST {host}/batch/` with the project token), for the dispatcher in
 * `dispatch.ts`. Offline tooling only.
 *
 * Deliberately not `posthog-node`: its `captureImmediate` catches send
 * errors and only emits an `'error'` event (`@posthog/core`
 * `sendImmediate`), so it resolves even when nothing was accepted, and the
 * dispatcher would mark undelivered rows delivered. Here a 2xx response is
 * the only success; anything else throws a categorized `SinkError`.
 */

export const SINK_ERROR_CATEGORIES = [
  'auth',
  'rate_limited',
  'payload_too_large',
  'http_4xx',
  'http_5xx',
  'timeout',
  'network',
] as const
export type SinkErrorCategory = (typeof SINK_ERROR_CATEGORIES)[number]

export class SinkError extends Error {
  readonly category: SinkErrorCategory
  readonly status: number | null

  constructor(category: SinkErrorCategory, status: number | null) {
    super(`PostHog batch capture failed: ${category}${status === null ? '' : ` (HTTP ${status})`}`)
    this.name = 'SinkError'
    this.category = category
    this.status = status
  }
}

export type Sink = {send(events: CaptureEvent[]): Promise<void>}

export const DEFAULT_SINK_TIMEOUT_MS = 10_000

function categorize(status: number): SinkErrorCategory {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate_limited'
  if (status === 413) return 'payload_too_large'
  return status >= 500 ? 'http_5xx' : 'http_4xx'
}

export function createPostHogSink({
  host,
  projectToken,
  timeoutMs = DEFAULT_SINK_TIMEOUT_MS,
  fetchImpl = fetch,
}: {
  host: string
  projectToken: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): Sink {
  const url = `${host.replace(/\/+$/, '')}/batch/`
  return {
    async send(events) {
      if (events.length === 0) return
      let response: Response
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({api_key: projectToken, batch: events}),
          signal: AbortSignal.timeout(timeoutMs),
        })
        // Drain the body so the connection is released; its content is not needed.
        await response.arrayBuffer()
      } catch (error) {
        const name = (error as {name?: string})?.name
        throw new SinkError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network', null)
      }
      if (!response.ok) throw new SinkError(categorize(response.status), response.status)
    },
  }
}
