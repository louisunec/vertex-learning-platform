import {readFile} from 'node:fs/promises'

import {z} from 'zod'

/**
 * Reads the analytics events that two signal types need (`search_outcome`
 * for searches with no grounded results, `video_played` and `video_seeked`
 * for replays) from PostHog, for the offline aggregator only.
 *
 * - `createHogQLReader`: PostHog's query API (`POST
 *   {apiHost}/api/projects/{projectId}/query/`, a HogQL query). It needs a
 *   personal API key with the `query:read` scope and the numeric project id;
 *   the project token and the feature-flag secret (`phs_…`) cannot query.
 *   It selects only the named, non-text properties, passes every value
 *   through HogQL placeholders, and pages up to a hard row cap.
 * - `createFixtureReader`: the same interface over a JSON file, for tests,
 *   fixture demonstrations, and runs without PostHog credentials.
 *
 * Both exclude labelled synthetic learners by distinct id, and both return
 * each event `uuid` once: PostHog merges resent duplicates only eventually
 * (on ClickHouse merges), so a query can still see both copies.
 */

export type AnalyticsEvent = {
  uuid: string
  event: string
  distinctId: string
  /** PostHog's merged person id (anonymous and identified ids of one person share it). */
  personId: string
  timestamp: string
  properties: Record<string, unknown>
}

export type EventQuery = {
  event: string
  start: Date
  end: Date
  /** Property names to select; plain identifiers only. */
  properties: readonly string[]
  excludeDistinctIds: readonly string[]
}

export type EventReader = {
  kind: 'posthog' | 'fixture'
  readEvents(query: EventQuery): Promise<AnalyticsEvent[]>
}

export class EventReaderError extends Error {
  readonly code: 'too_many_events' | 'query_failed' | 'invalid_response'
  constructor(code: EventReaderError['code'], message: string) {
    super(message)
    this.name = 'EventReaderError'
    this.code = code
  }
}

const PROPERTY_NAME = /^[a-z][a-z0-9_]{0,63}$/
const EVENT_NAME = /^[a-z][a-z0-9_]{0,63}$/

export const HOGQL_PAGE_SIZE = 5_000
export const MAX_EVENTS_PER_QUERY = 20_000
const QUERY_TIMEOUT_MS = 60_000

function assertQuery(query: EventQuery): void {
  if (!EVENT_NAME.test(query.event)) throw new RangeError(`Invalid event name: ${query.event}`)
  for (const name of query.properties) if (!PROPERTY_NAME.test(name)) throw new RangeError(`Invalid property name: ${name}`)
}

/** The app API host for a capture host: `https://us.i.posthog.com` → `https://us.posthog.com`. */
export function apiHostFor(captureHost: string): string {
  return captureHost.replace(/\/+$/, '').replace(/^(https?:\/\/)([a-z0-9-]+)\.i\.posthog\.com$/i, '$1$2.posthog.com')
}

export function buildHogQL(query: EventQuery, offset: number, limit: number): {query: string; values: Record<string, unknown>} {
  assertQuery(query)
  const columns = ['uuid', 'distinct_id', 'person_id', 'timestamp', ...query.properties.map((name) => `properties.${name}`)]
  const where = ['event = {event}', 'timestamp >= toDateTime({start})', 'timestamp < toDateTime({end})']
  if (query.excludeDistinctIds.length > 0) where.push('distinct_id NOT IN {excluded}')
  return {
    query: `SELECT ${columns.join(', ')} FROM events WHERE ${where.join(' AND ')} ORDER BY timestamp, uuid LIMIT ${limit} OFFSET ${offset}`,
    values: {
      event: query.event,
      start: query.start.toISOString(),
      end: query.end.toISOString(),
      ...(query.excludeDistinctIds.length > 0 ? {excluded: [...query.excludeDistinctIds]} : {}),
    },
  }
}

const hogqlResponse = z.object({results: z.array(z.array(z.unknown()))})

export function createHogQLReader({
  apiHost,
  projectId,
  personalApiKey,
  fetchImpl = fetch,
  maxEvents = MAX_EVENTS_PER_QUERY,
}: {
  apiHost: string
  projectId: string
  personalApiKey: string
  fetchImpl?: typeof fetch
  maxEvents?: number
}): EventReader {
  if (!/^\d+$/.test(projectId)) throw new RangeError('POSTHOG_PROJECT_ID must be the numeric project id')
  const url = `${apiHost.replace(/\/+$/, '')}/api/projects/${projectId}/query/`
  return {
    kind: 'posthog',
    async readEvents(query) {
      const events: AnalyticsEvent[] = []
      const seen = new Set<string>()
      for (let offset = 0; ; offset += HOGQL_PAGE_SIZE) {
        const hogql = buildHogQL(query, offset, HOGQL_PAGE_SIZE)
        let response: Response
        try {
          response = await fetchImpl(url, {
            method: 'POST',
            headers: {'content-type': 'application/json', authorization: `Bearer ${personalApiKey}`},
            body: JSON.stringify({query: {kind: 'HogQLQuery', ...hogql}, name: `vertex-signals-${query.event}`}),
            signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
          })
        } catch (error) {
          throw new EventReaderError('query_failed', `PostHog query failed: ${(error as Error).name}`)
        }
        if (!response.ok) {
          await response.arrayBuffer().catch(() => undefined)
          throw new EventReaderError('query_failed', `PostHog query failed: HTTP ${response.status}`)
        }
        const parsed = hogqlResponse.safeParse(await response.json().catch(() => null))
        if (!parsed.success) throw new EventReaderError('invalid_response', 'PostHog query returned an unexpected shape')
        for (const row of parsed.data.results) {
          const [uuid, distinctId, personId, timestamp, ...values] = row
          if (seen.has(String(uuid))) continue
          seen.add(String(uuid))
          events.push({
            uuid: String(uuid),
            event: query.event,
            distinctId: String(distinctId),
            personId: String(personId ?? distinctId),
            timestamp: String(timestamp),
            properties: Object.fromEntries(query.properties.map((name, index) => [name, values[index] ?? null])),
          })
        }
        if (events.length > maxEvents) {
          throw new EventReaderError('too_many_events', `More than ${maxEvents} ${query.event} events in one window; use a shorter window`)
        }
        if (parsed.data.results.length < HOGQL_PAGE_SIZE) return events
      }
    },
  }
}

const fixtureEvent = z.object({
  uuid: z.string().min(1),
  event: z.string().regex(EVENT_NAME),
  distinct_id: z.string().min(1),
  person_id: z.string().min(1).optional(),
  timestamp: z.iso.datetime({offset: true}),
  properties: z.record(z.string(), z.unknown()).default({}),
})
const fixtureFile = z.object({description: z.string().optional(), events: z.array(fixtureEvent)})

export function createFixtureReader(events: z.input<typeof fixtureEvent>[]): EventReader {
  const parsed = z.array(fixtureEvent).parse(events)
  return {
    kind: 'fixture',
    async readEvents(query) {
      assertQuery(query)
      const excluded = new Set(query.excludeDistinctIds)
      const seen = new Set<string>()
      return parsed
        .filter((event) => event.event === query.event && !excluded.has(event.distinct_id))
        .filter((event) => !seen.has(event.uuid) && Boolean(seen.add(event.uuid)))
        .filter((event) => {
          const at = Date.parse(event.timestamp)
          return at >= query.start.getTime() && at < query.end.getTime()
        })
        .map((event) => ({
          uuid: event.uuid,
          event: event.event,
          distinctId: event.distinct_id,
          personId: event.person_id ?? event.distinct_id,
          timestamp: event.timestamp,
          properties: Object.fromEntries(query.properties.map((name) => [name, event.properties[name] ?? null])),
        }))
    },
  }
}

export async function loadFixtureReader(path: string): Promise<EventReader> {
  const file = fixtureFile.parse(JSON.parse(await readFile(path, 'utf8')))
  return createFixtureReader(file.events)
}
