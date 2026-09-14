import type postgres from 'postgres'

import {finishJobRun, startJobRun} from '../db/job-run.ts'
import {evaluateAssessment, readAssessmentAggregates} from './assessment-difficulty.ts'
import type {SignalCandidate} from './candidate.ts'
import {DEFAULT_THRESHOLDS, SIGNAL_SOURCES, SIGNAL_TYPES, type SignalThresholds, type SignalType} from './config.ts'
import {planSignalWrites, type PlannedSignal} from './documents.ts'
import type {EventReader} from './posthog-reader.ts'
import {queueRegeneration, type QueueResult} from './regenerate.ts'
import {aggregateReplayHotspots, PLAY_PROPERTIES, SEEK_PROPERTIES} from './replay.ts'
import type {SignalStore} from './sanity-store.ts'
import {aggregateSearchGaps, SEARCH_OUTCOME_PROPERTIES} from './search-gaps.ts'
import {listSyntheticLearners} from './synthetic.ts'
import {evaluateTutorGap, readTutorAggregates} from './tutor-gaps.ts'
import {isPartial, type SignalWindow} from './windows.ts'

/**
 * One aggregation run (`npm run signals -- aggregate`, development plan §5
 * PR-10): for each window, each signal type is computed from its source,
 * independently. A type whose source is unavailable (no PostHog reader, a
 * failed query, tutor off) is reported as skipped or failed and never
 * blocks the others. Writes are idempotent (`documents.ts`), so a window
 * can be rerun at any time; with no store the run is a dry run that writes
 * nothing to Sanity or to the regeneration queue.
 */

export type TypeReport = {
  status: 'ok' | 'skipped' | 'failed'
  detail: string | null
  subjects: number
  raised: number
  excluded?: Record<string, number>
}

export type WindowReport = {
  window: SignalWindow
  partial: boolean
  types: Record<SignalType, TypeReport>
  planned: PlannedSignal[]
  regeneration: Array<{signalId: string; result: QueueResult}>
}

export type AggregateOptions = {
  db: postgres.Sql
  /** PostHog (or fixture) events; null skips the PostHog-backed types. */
  reader: EventReader | null
  /** Sanity; null makes the run a dry run. */
  store: SignalStore | null
  windows: SignalWindow[]
  now: Date
  workerId: string
  thresholds?: SignalThresholds
  types?: readonly SignalType[]
  /** Queue draft regeneration for raised assessment signals (needs a store). */
  regeneration?: {dailyCap?: number} | false
  /** Label every signal as fixture data (default: when the events come from a fixture file). */
  fixture?: boolean
  recordRun?: boolean
}

type Computed = {candidates: SignalCandidate[]; excluded?: Record<string, number>}

async function computeType(
  type: SignalType,
  {db, reader, window, thresholds, synthetic}: {db: postgres.Sql; reader: EventReader; window: SignalWindow; thresholds: SignalThresholds; synthetic: string[]},
): Promise<Computed> {
  const query = {start: window.start, end: window.end, excludeDistinctIds: synthetic}
  switch (type) {
    case 'assessment_difficulty':
      return {candidates: (await readAssessmentAggregates(db, window)).map((row) => evaluateAssessment(row, thresholds.assessment))}
    case 'tutor_insufficient_evidence': {
      const {aggregates, buckets} = await readTutorAggregates(db, window)
      return {candidates: aggregates.map((row) => evaluateTutorGap(row, buckets, thresholds.tutor))}
    }
    case 'search_no_results': {
      const events = await reader.readEvents({...query, event: 'search_outcome', properties: SEARCH_OUTCOME_PROPERTIES})
      const report = aggregateSearchGaps(events, thresholds.search)
      return {candidates: report.candidates, excluded: {...report.excluded, searches: report.total}}
    }
    case 'replay_hotspot': {
      const [seeks, plays] = await Promise.all([
        reader.readEvents({...query, event: 'video_seeked', properties: SEEK_PROPERTIES}),
        reader.readEvents({...query, event: 'video_played', properties: PLAY_PROPERTIES}),
      ])
      const report = aggregateReplayHotspots({seeks, plays, thresholds: thresholds.replay})
      return {candidates: report.candidates, excluded: report.excluded}
    }
  }
}

export async function aggregateSignals(options: AggregateOptions): Promise<WindowReport[]> {
  const {db, reader, store, windows, now, workerId, recordRun = false} = options
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS
  const types = options.types ?? SIGNAL_TYPES
  const fixture = options.fixture ?? reader?.kind === 'fixture'
  const synthetic = (await listSyntheticLearners(db)).map((row) => row.learnerId)
  const reports: WindowReport[] = []

  for (const window of windows) {
    const partial = isPartial(window, now)
    const runId = recordRun ? await startJobRun(db, 'signal_aggregation', workerId, window) : null
    const report: WindowReport = {
      window,
      partial,
      types: Object.fromEntries(
        SIGNAL_TYPES.map((type) => [type, {status: 'skipped', detail: 'not requested', subjects: 0, raised: 0} satisfies TypeReport]),
      ) as Record<SignalType, TypeReport>,
      planned: [],
      regeneration: [],
    }
    const candidates: SignalCandidate[] = []

    try {
      for (const type of types) {
        if (SIGNAL_SOURCES[type] === 'posthog' && !reader) {
          report.types[type] = {status: 'skipped', detail: 'posthog_unavailable', subjects: 0, raised: 0}
          continue
        }
        try {
          const computed = await computeType(type, {db, reader: reader!, window, thresholds, synthetic})
          candidates.push(...computed.candidates)
          report.types[type] = {
            status: 'ok',
            detail: null,
            subjects: computed.candidates.length,
            raised: computed.candidates.filter((candidate) => candidate.thresholdMet).length,
            ...(computed.excluded ? {excluded: computed.excluded} : {}),
          }
        } catch (error) {
          report.types[type] = {status: 'failed', detail: error instanceof Error ? error.message.slice(0, 200) : 'failed', subjects: 0, raised: 0}
        }
      }

      const existingIds = store ? await store.existingIds(window.key) : new Set<string>()
      const {planned, mutations} = planSignalWrites(candidates, {window, partial, fixture, computedAt: now, existingIds})
      report.planned = planned
      if (store && mutations.length > 0) await store.commit(mutations)

      if (store && options.regeneration !== false) {
        const raised = planned.filter((entry) => entry.candidate.type === 'assessment_difficulty' && entry.candidate.thresholdMet)
        const sources = new Map(
          (await store.readAssessmentSources(raised.map((entry) => entry.candidate.assessment!.id))).map((source) => [source._id, source]),
        )
        for (const entry of raised) {
          const assessment = entry.candidate.assessment!
          const result = await queueRegeneration(
            db,
            {signalId: entry.id, assessmentId: assessment.id, lessonId: entry.candidate.lessonId, familyId: assessment.familyId, version: assessment.version},
            sources.get(assessment.id) ?? null,
            {now, dailyCap: options.regeneration?.dailyCap},
          )
          report.regeneration.push({signalId: entry.id, result})
          if (result.status === 'queued') {
            await store.setRegeneration(entry.id, {status: 'queued', candidateId: result.candidateId, queuedDay: result.queuedDay})
          }
        }
      }
    } catch (error) {
      if (runId) await finishJobRun(db, runId, {status: 'failed', counts: countsOf(report), error: (error as Error).message}).catch(() => undefined)
      throw error
    }

    if (runId) {
      const failed = Object.values(report.types).some((entry) => entry.status === 'failed')
      await finishJobRun(db, runId, {status: failed ? 'failed' : 'succeeded', counts: countsOf(report)})
    }
    reports.push(report)
  }
  return reports
}

function countsOf(report: WindowReport) {
  return {
    partial: report.partial ? 1 : 0,
    written: report.planned.length,
    queued: report.regeneration.filter((entry) => entry.result.status === 'queued').length,
    ...Object.fromEntries(
      Object.entries(report.types).map(([type, entry]) => [
        type,
        {status: entry.status, detail: entry.detail, subjects: entry.subjects, raised: entry.raised, ...(entry.excluded ?? {})},
      ]),
    ),
  }
}
