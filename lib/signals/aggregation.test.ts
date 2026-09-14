import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {describe, it} from 'node:test'

import {outcomeTerms, termsFingerprint} from '../search/outcome.ts'
import {signalDocumentId, type SignalCandidate} from './candidate.ts'
import {DEFAULT_THRESHOLDS} from './config.ts'
import {planSignalWrites, REVIEW_FIELDS} from './documents.ts'
import {createFixtureReader, loadFixtureReader, type AnalyticsEvent} from './posthog-reader.ts'
import {aggregateReplayHotspots, PLAY_PROPERTIES, SEEK_PROPERTIES} from './replay.ts'
import {MemorySignalStore} from './sanity-store.ts'
import {aggregateSearchGaps, SEARCH_OUTCOME_PROPERTIES} from './search-gaps.ts'
import {windowContaining, windowsToProcess} from './windows.ts'

/**
 * Pure aggregation over fixture events (development plan §5 PR-10). The
 * fixture file is synthetic and labelled as such; see
 * docs/editorial-signals/fixture-events.json.
 */

const FIXTURE = new URL('../../docs/editorial-signals/fixture-events.json', import.meta.url)
const WINDOW = windowContaining(new Date('2026-09-10T00:00:00Z'), 7)

const event = (overrides: Partial<AnalyticsEvent> & {properties: Record<string, unknown>}): AnalyticsEvent => ({
  uuid: crypto.randomUUID(),
  event: 'video_seeked',
  distinctId: 'p1',
  personId: 'p1',
  timestamp: '2026-09-09T10:00:00Z',
  ...overrides,
})

async function fixtureEvents(name: string, properties: readonly string[]) {
  const reader = await loadFixtureReader(FIXTURE.pathname)
  return reader.readEvents({event: name, start: WINDOW.start, end: WINDOW.end, properties, excludeDistinctIds: []})
}

describe('signal windows', () => {
  it('aligns fixed half-open UTC windows to a Monday anchor', () => {
    const window = windowContaining(new Date('2026-09-10T12:00:00Z'), 7)
    assert.equal(window.start.toISOString(), '2026-09-07T00:00:00.000Z')
    assert.equal(window.end.toISOString(), '2026-09-14T00:00:00.000Z')
    assert.equal(window.key, '20260907-7d')
    // A boundary instant belongs to the next window.
    assert.equal(windowContaining(new Date('2026-09-14T00:00:00Z'), 7).key, '20260914-7d')
    assert.equal(windowContaining(new Date('2026-09-13T23:59:59.999Z'), 7).key, '20260907-7d')
  })

  it('processes the last completed windows, plus the current one on request', () => {
    const now = new Date('2026-09-16T08:00:00Z')
    assert.deepEqual(windowsToProcess({now, days: 7, lookback: 1}).map((window) => window.key), ['20260831-7d', '20260907-7d'])
    assert.deepEqual(windowsToProcess({now, days: 7, lookback: 0, includeCurrent: true}).map((window) => window.key), ['20260907-7d', '20260914-7d'])
    assert.throws(() => windowContaining(now, 0), RangeError)
    assert.throws(() => windowContaining(now, 29), RangeError)
  })
})

describe('replay hotspots', () => {
  it('raises the fixture replay stretch and excludes citation jumps, skips, and restarts', async () => {
    const report = aggregateReplayHotspots({
      seeks: await fixtureEvents('video_seeked', SEEK_PROPERTIES),
      plays: await fixtureEvents('video_played', PLAY_PROPERTIES),
      thresholds: DEFAULT_THRESHOLDS.replay,
    })
    assert.deepEqual(report.excluded, {citation: 4, skip: 1, rewind_far: 1, invalid: 0, untracked_plays: 3})
    const raised = report.candidates.filter((candidate) => candidate.thresholdMet)
    assert.equal(raised.length, 1)
    const [hotspot] = raised
    assert.equal(hotspot.subjectKey, 'lesson-hooks|youtube-hooksvideo1|90')
    assert.deepEqual(hotspot.timestamp, {startSeconds: 90, endSeconds: 120})
    assert.equal(hotspot.measurement.numerator, 6, 'six people, the repeat replayer counted once')
    assert.equal(hotspot.measurement.denominator, 10, 'the three plays without seek tracking are not viewers here')
    assert.equal(hotspot.measurement.rate, 0.6)
    assert.equal(hotspot.supporting.find((metric) => metric.key === 'replay_events')?.value, 8)
    assert.equal(hotspot.supporting.find((metric) => metric.key === 'citation_jumps')?.value, 4)
    assert.match(hotspot.reason, /friction or interest/)
  })

  it('counts one person once per stretch however often they replay it', () => {
    const seeks = Array.from({length: 12}, () =>
      event({properties: {lesson_id: 'l1', video_id: 'v1', from_seconds: 70, to_seconds: 40, seek_kind: 'replay', seek_origin: 'learner'}}),
    )
    const report = aggregateReplayHotspots({seeks, plays: [], thresholds: DEFAULT_THRESHOLDS.replay})
    assert.equal(report.candidates[0].measurement.numerator, 1)
    assert.equal(report.candidates[0].thresholdMet, false)
  })

  it('does not treat citation jumps as confusion even when many people make them', () => {
    const seeks = Array.from({length: 20}, (_, index) =>
      event({personId: `p${index}`, properties: {lesson_id: 'l1', video_id: 'v1', from_seconds: 300, to_seconds: 40, seek_kind: 'replay', seek_origin: 'citation'}}),
    )
    const report = aggregateReplayHotspots({seeks, plays: [], thresholds: DEFAULT_THRESHOLDS.replay})
    assert.equal(report.candidates.length, 0)
    assert.equal(report.excluded.citation, 20)
  })
})

describe('searches with no grounded results', () => {
  it('raises a genuine no-result search and keeps outages out', async () => {
    const report = aggregateSearchGaps(await fixtureEvents('search_outcome', SEARCH_OUTCOME_PROPERTIES), DEFAULT_THRESHOLDS.search)
    assert.deepEqual(report.excluded, {no_results_degraded: 5, unavailable: 3, failed: 0, no_terms: 0})
    assert.equal(report.total, 15)

    const gap = outcomeTerms('How do I rotate an OAuth refresh token?')
    const raised = report.candidates.filter((candidate) => candidate.thresholdMet)
    assert.equal(raised.length, 1)
    assert.equal(raised[0].subjectKey, termsFingerprint(gap))
    assert.deepEqual(raised[0].searchTerms, gap)
    assert.equal(raised[0].measurement.distinctLearners, 4)
    assert.match(raised[0].reason, /may still cover the topic/)

    // The outage's terms produce no candidate at all: none of its searches was a genuine no-result.
    const outage = termsFingerprint(outcomeTerms('kubernetes ingress controller'))
    assert.equal(report.candidates.some((candidate) => candidate.subjectKey === outage), false)
  })

  it('shows terms only on raised signals, and never prose', () => {
    const fingerprint = termsFingerprint(['vectors'])
    const one = event({
      event: 'search_outcome',
      properties: {outcome: 'no_results', terms: ['vectors'], terms_fingerprint: fingerprint},
    })
    const report = aggregateSearchGaps([one], DEFAULT_THRESHOLDS.search)
    assert.equal(report.candidates[0].thresholdMet, false)
    assert.equal(report.candidates[0].searchTerms, null)

    const prose = Array.from({length: 3}, (_, index) =>
      event({
        event: 'search_outcome',
        personId: `p${index}`,
        properties: {outcome: 'no_results', terms: ['my full question about vectors'], terms_fingerprint: fingerprint},
      }),
    )
    const raised = aggregateSearchGaps(prose, DEFAULT_THRESHOLDS.search).candidates[0]
    assert.equal(raised.thresholdMet, true)
    assert.equal(raised.searchTerms, null, 'a term that is not a single keyword is dropped')
  })

  it('reads array properties that HogQL returns as JSON text', () => {
    const fingerprint = termsFingerprint(['kafka'])
    const rows = Array.from({length: 3}, (_, index) =>
      event({event: 'search_outcome', personId: `p${index}`, properties: {outcome: 'no_results', terms: '["kafka"]', terms_fingerprint: fingerprint}}),
    )
    assert.deepEqual(aggregateSearchGaps(rows, DEFAULT_THRESHOLDS.search).candidates[0].searchTerms, ['kafka'])
  })
})

describe('fixture reader', () => {
  it('filters by event, half-open window, and excluded distinct ids, selecting only named properties', async () => {
    const reader = createFixtureReader([
      {uuid: 'a', event: 'video_played', distinct_id: 'x', timestamp: '2026-09-07T00:00:00Z', properties: {lesson_id: 'l', secret: 'nope'}},
      {uuid: 'b', event: 'video_played', distinct_id: 'y', timestamp: '2026-09-14T00:00:00Z', properties: {lesson_id: 'l'}},
      {uuid: 'c', event: 'video_played', distinct_id: 'demo', timestamp: '2026-09-08T00:00:00Z', properties: {lesson_id: 'l'}},
    ])
    const rows = await reader.readEvents({event: 'video_played', start: WINDOW.start, end: WINDOW.end, properties: ['lesson_id'], excludeDistinctIds: ['demo']})
    assert.deepEqual(rows.map((row) => row.uuid), ['a'])
    assert.deepEqual(rows[0].properties, {lesson_id: 'l'})
  })

  it('is labelled as synthetic data', async () => {
    const file = JSON.parse(await readFile(FIXTURE, 'utf8')) as {description: string}
    assert.match(file.description, /^FIXTURE: synthetic/)
  })
})

describe('signal documents', () => {
  const candidate = (overrides: Partial<SignalCandidate> = {}): SignalCandidate => ({
    type: 'assessment_difficulty',
    subjectKey: 'assessment-asm-1a2b3c4d-s0-q0-v2',
    thresholdMet: true,
    reason: 'reason',
    lessonId: 'lesson-hooks',
    assessment: {id: 'assessment-asm-1a2b3c4d-s0-q0-v2', familyId: 'asm-1a2b3c4d-s0-q0', version: 2},
    timestamp: null,
    measurement: {numerator: 15, numeratorLabel: 'n', denominator: 20, denominatorLabel: 'd', rate: 0.75, distinctLearners: 20},
    supporting: [{key: 'assisted', label: 'Assisted', value: 3}],
    searchTerms: null,
    rule: 'rule',
    ...overrides,
  })
  const options = (existingIds: Set<string>) => ({window: WINDOW, partial: false, fixture: false, computedAt: new Date('2026-09-14T01:00:00Z'), existingIds})

  it('uses one stable id per subject and window', () => {
    const id = signalDocumentId('assessment_difficulty', 'assessment-asm-1a2b3c4d-s0-q0-v2', WINDOW)
    assert.match(id, /^contentSignal-assessment-[0-9a-f]{16}-20260907-7d$/)
    assert.equal(id, signalDocumentId('assessment_difficulty', 'assessment-asm-1a2b3c4d-s0-q0-v2', WINDOW))
    assert.notEqual(id, signalDocumentId('assessment_difficulty', 'assessment-asm-1a2b3c4d-s0-q0-v1', WINDOW))
    assert.notEqual(id, signalDocumentId('assessment_difficulty', 'assessment-asm-1a2b3c4d-s0-q0-v2', windowContaining(new Date('2026-09-15T00:00:00Z'), 7)))
  })

  it('never writes review fields after creating a signal, so reruns keep the instructor’s review', async () => {
    const store = new MemorySignalStore()
    const first = planSignalWrites([candidate()], options(new Set()))
    for (const mutation of first.mutations) {
      if ('patch' in mutation) for (const field of REVIEW_FIELDS) assert.equal(field in mutation.patch.set, false, field)
    }
    await store.commit(first.mutations)
    const [id] = store.documents.keys()
    Object.assign(store.documents.get(id)!, {reviewStatus: 'resolved', reviewNote: 'Answer key fixed in v3'})

    const rerun = planSignalWrites([candidate({measurement: {...candidate().measurement, numerator: 16}})], options(await store.existingIds(WINDOW.key)))
    await store.commit(rerun.mutations)
    const doc = store.documents.get(id)!
    assert.equal(doc.reviewStatus, 'resolved')
    assert.equal(doc.reviewNote, 'Answer key fixed in v3')
    assert.equal((doc.measurement as {numerator: number}).numerator, 16, 'metrics are replaced, not added')
  })

  it('creates nothing below threshold, but marks an existing signal as no longer meeting it', async () => {
    const store = new MemorySignalStore()
    assert.equal(planSignalWrites([candidate({thresholdMet: false})], options(new Set())).mutations.length, 0)
    await store.commit(planSignalWrites([candidate()], options(new Set())).mutations)
    const refresh = planSignalWrites([candidate({thresholdMet: false})], options(await store.existingIds(WINDOW.key)))
    assert.equal(refresh.planned[0].action, 'refresh')
    await store.commit(refresh.mutations)
    const [doc] = store.documents.values()
    assert.equal(doc.thresholdMet, false)
    assert.equal(doc.reviewStatus, 'open')
  })

  it('labels fixture signals and keeps titles neutral', () => {
    const {planned} = planSignalWrites([candidate(), candidate({type: 'replay_hotspot', subjectKey: 'l|v|210', assessment: null, timestamp: {startSeconds: 210, endSeconds: 240}})], {
      ...options(new Set()),
      fixture: true,
    })
    assert.deepEqual(planned.map((entry) => entry.fields.title), ['[Fixture] High first-attempt error rate (v2)', '[Fixture] Repeated replays around 3:30'])
    assert.equal(planned[0].fields.source, 'fixture')
    for (const entry of planned) assert.doesNotMatch(entry.fields.title, /bad|wrong|broken|confusing/i)
  })
})
