import assert from 'node:assert/strict'
import {readdir, readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {describe, it} from 'node:test'
import {fileURLToPath} from 'node:url'

import {classifySearchOutcome, outcomeTerms, termsFingerprint} from '../search/outcome.ts'
import {SEEK_TRACKING_FLAG} from '../video/seek.ts'
import {apiHostFor, buildHogQL, createFixtureReader, createHogQLReader, EventReaderError} from './posthog-reader.ts'

/**
 * Boundaries of the editorial signals (development plan §5 PR-10): signals
 * never reach learner search or public APIs, search outcomes separate
 * content misses from infrastructure failures, and PostHog queries are
 * parameterized and bounded.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(join(ROOT, dir), {withFileTypes: true, recursive: true})
  return entries
    .filter((entry) => entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
}

describe('signals stay out of learner surfaces', () => {
  it('no app route, component, or learner query reads contentSignal documents', async () => {
    const files = [...(await sourceFiles('app')), ...(await sourceFiles('components')), ...(await sourceFiles('sanity')), ...(await sourceFiles('lib/search')), ...(await sourceFiles('lib/learner')), ...(await sourceFiles('lib/tutor'))]
    assert.ok(files.length > 20)
    for (const file of files) {
      assert.equal((await readFile(file, 'utf8')).includes('contentSignal'), false, file)
    }
  })

  it('the search Context document allowlists learner content types only', async () => {
    const ndjson = await readFile(join(ROOT, 'studio/scripts/context/search-context.ndjson'), 'utf8')
    const filters = ndjson
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as {groqFilter?: string})
      .map((doc) => doc.groqFilter)
      .filter((filter): filter is string => typeof filter === 'string')
    assert.ok(filters.length > 0)
    for (const filter of filters) {
      assert.match(filter, /^_type in \[/)
      assert.equal(filter.includes('contentSignal'), false)
    }
  })
})

describe('editorial telemetry costs lesson pages nothing on the server', () => {
  it('the player reads the same flag key the server defines', async () => {
    assert.match(await readFile(join(ROOT, 'lib/flags.ts'), 'utf8'), new RegExp(`editorialSignals: '${SEEK_TRACKING_FLAG}'`))
  })

  it('the lesson page does not evaluate the editorial flag while rendering', async () => {
    const page = await readFile(join(ROOT, 'app/lessons/[slug]/page.tsx'), 'utf8')
    assert.equal(/editorialSignals|editorial-signals/.test(page), false)
  })

  it('the search route evaluates the editorial flag locally only, after the response', async () => {
    const route = await readFile(join(ROOT, 'app/api/search/route.ts'), 'utf8')
    assert.match(route, /isFlagEnabled\(FLAGS\.editorialSignals, distinctId, \{localOnly: true\}\)/)
  })
})

describe('search outcomes', () => {
  it('separates a content miss from degraded, unavailable, failed, and empty queries', () => {
    assert.equal(classifySearchOutcome({total: 3, termCount: 2, interpretation: 'model'}), 'results')
    assert.equal(classifySearchOutcome({total: 0, termCount: 2, interpretation: 'model'}), 'no_results')
    assert.equal(classifySearchOutcome({total: 0, termCount: 2, interpretation: 'deterministic'}), 'no_results')
    assert.equal(classifySearchOutcome({total: 0, termCount: 2, interpretation: 'fallback_after_error'}), 'no_results_degraded')
    assert.equal(classifySearchOutcome({total: 4, termCount: 2, interpretation: 'fallback_after_error'}), 'results')
    assert.equal(classifySearchOutcome({total: 0, termCount: 0, interpretation: 'model'}), 'no_terms')
    assert.equal(classifySearchOutcome({error: 'unavailable'}), 'unavailable')
    assert.equal(classifySearchOutcome({error: 'failed'}), 'failed')
  })

  it('reduces a query to a few tokenized keywords with a stable fingerprint, never the raw text', () => {
    const terms = outcomeTerms('How do I rotate an OAuth refresh token? My email is ada@example.com')
    assert.ok(terms.length <= 6)
    for (const term of terms) assert.match(term, /^[\p{L}\p{N}][\p{L}\p{N}+#._-]{0,31}$/u)
    assert.equal(terms.join(' ').includes('How do I'), false)
    assert.deepEqual(outcomeTerms('refresh OAuth token rotate'), outcomeTerms('Rotate the oauth refresh token'))
    assert.equal(termsFingerprint(outcomeTerms('refresh OAuth token rotate')), termsFingerprint(outcomeTerms('Rotate the oauth refresh token')))
    assert.match(termsFingerprint(terms), /^[0-9a-f]{16}$/)
  })
})

describe('PostHog query reader', () => {
  it('derives the app API host from the capture host', () => {
    assert.equal(apiHostFor('https://us.i.posthog.com'), 'https://us.posthog.com')
    assert.equal(apiHostFor('https://eu.i.posthog.com/'), 'https://eu.posthog.com')
    assert.equal(apiHostFor('https://posthog.example.com'), 'https://posthog.example.com')
  })

  it('passes every value as a HogQL placeholder and selects only named properties', () => {
    const query = buildHogQL(
      {event: 'video_seeked', start: new Date('2026-09-07T00:00:00Z'), end: new Date('2026-09-14T00:00:00Z'), properties: ['lesson_id', 'to_seconds'], excludeDistinctIds: ["user_x' OR 1=1 --"]},
      0,
      5000,
    )
    assert.equal(
      query.query,
      'SELECT uuid, distinct_id, person_id, timestamp, properties.lesson_id, properties.to_seconds FROM events WHERE event = {event} AND timestamp >= toDateTime({start}) AND timestamp < toDateTime({end}) AND distinct_id NOT IN {excluded} ORDER BY timestamp, uuid LIMIT 5000 OFFSET 0',
    )
    assert.deepEqual(query.values.excluded, ["user_x' OR 1=1 --"])
    assert.throws(() => buildHogQL({event: 'x; drop', start: new Date(), end: new Date(), properties: [], excludeDistinctIds: []}, 0, 1), RangeError)
    assert.throws(() => buildHogQL({event: 'x', start: new Date(), end: new Date(), properties: ['query) OR (1'], excludeDistinctIds: []}, 0, 1), RangeError)
  })

  it('pages results, stops at the row cap, and reports failures without leaking the key', async () => {
    const requests: Array<{url: string; auth: string | null; body: {query: {kind: string; query: string}}}> = []
    const rows = (count: number, offset: number) => Array.from({length: count}, (_, index) => [`uuid-${offset + index}`, 'd', 'p', '2026-09-08T00:00:00Z', 'lesson-1'])
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      requests.push({url, auth: new Headers(init.headers).get('authorization'), body})
      const offset = Number(/OFFSET (\d+)/.exec(body.query.query)![1])
      return new Response(JSON.stringify({results: rows(offset === 0 ? 5000 : 12, offset)}))
    }) as typeof fetch
    const reader = createHogQLReader({apiHost: 'https://us.posthog.com', projectId: '12345', personalApiKey: 'phx_secret', fetchImpl})
    const events = await reader.readEvents({event: 'video_played', start: new Date('2026-09-07T00:00:00Z'), end: new Date('2026-09-14T00:00:00Z'), properties: ['lesson_id'], excludeDistinctIds: []})
    assert.equal(events.length, 5012)
    assert.equal(requests.length, 2)
    assert.equal(requests[0].url, 'https://us.posthog.com/api/projects/12345/query/')
    assert.equal(requests[0].auth, 'Bearer phx_secret')
    assert.equal(requests[0].body.query.kind, 'HogQLQuery')
    assert.deepEqual(events[0].properties, {lesson_id: 'lesson-1'})

    const capped = createHogQLReader({apiHost: 'https://us.posthog.com', projectId: '12345', personalApiKey: 'phx_secret', fetchImpl, maxEvents: 4000})
    await assert.rejects(capped.readEvents({event: 'video_played', start: new Date(), end: new Date(), properties: [], excludeDistinctIds: []}), (error: unknown) => error instanceof EventReaderError && error.code === 'too_many_events')

    const denied = createHogQLReader({apiHost: 'https://us.posthog.com', projectId: '12345', personalApiKey: 'phx_secret', fetchImpl: (async () => new Response('forbidden', {status: 403})) as typeof fetch})
    await assert.rejects(denied.readEvents({event: 'video_played', start: new Date(), end: new Date(), properties: [], excludeDistinctIds: []}), (error: unknown) => {
      assert.ok(error instanceof EventReaderError)
      assert.equal(error.message.includes('phx_secret'), false)
      return error.code === 'query_failed'
    })
    assert.throws(() => createHogQLReader({apiHost: 'https://us.posthog.com', projectId: 'abc', personalApiKey: 'k'}), RangeError)
  })

  it('counts a resent event once, by its uuid, when PostHog has not merged the duplicate yet', async () => {
    const row = (uuid: string, distinctId: string) => [uuid, distinctId, distinctId, '2026-09-08T00:00:00Z', 'no_results']
    const fetchImpl = (async () =>
      new Response(JSON.stringify({results: [row('uuid-1', 'a'), row('uuid-1', 'a'), row('uuid-2', 'b')]}))) as unknown as typeof fetch
    const reader = createHogQLReader({apiHost: 'https://us.posthog.com', projectId: '12345', personalApiKey: 'phx_secret', fetchImpl})
    const query = {event: 'search_outcome', start: new Date('2026-09-07T00:00:00Z'), end: new Date('2026-09-14T00:00:00Z'), properties: ['outcome'], excludeDistinctIds: []}
    assert.deepEqual((await reader.readEvents(query)).map((event) => event.uuid), ['uuid-1', 'uuid-2'])

    const event = (uuid: string) => ({uuid, event: 'search_outcome', distinct_id: 'a', timestamp: '2026-09-08T00:00:00Z', properties: {outcome: 'no_results'}})
    const fixture = createFixtureReader([event('uuid-1'), event('uuid-1'), event('uuid-2')])
    assert.deepEqual((await fixture.readEvents(query)).map((row) => row.uuid), ['uuid-1', 'uuid-2'])
  })
})
