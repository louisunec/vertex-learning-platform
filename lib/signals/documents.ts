import {formatClock} from '../format.ts'
import {percent, signalDocumentId, type SignalCandidate} from './candidate.ts'
import {SIGNAL_RULES_VERSION, SIGNAL_SOURCES, SIGNAL_TITLES} from './config.ts'
import type {SignalWindow} from './windows.ts'

/**
 * `contentSignal` documents (Studio: Content signals) built from computed
 * candidates, and the mutations that write them.
 *
 * Reruns must never reset an instructor's review: a document is created
 * once with `reviewStatus: 'open'` (`createIfNotExists`), and every later
 * write is a `patch.set` of computed fields only. `REVIEW_FIELDS` are never
 * in that patch. Candidates below their threshold create nothing; if their
 * document already exists from an earlier run of the same window, it is
 * patched with `thresholdMet: false` and kept.
 */

export const CONTENT_SIGNAL_TYPE = 'contentSignal'

/** Written by instructors in the Studio; never by the job after creation. */
export const REVIEW_FIELDS = ['reviewStatus', 'reviewNote', 'reviewedAt', 'reviewedBy', 'regeneration'] as const

type Reference = {_type: 'reference'; _ref: string; _weak: true}
const weakRef = (id: string): Reference => ({_type: 'reference', _ref: id, _weak: true})

export type ComputedSignalFields = {
  signalType: SignalCandidate['type']
  title: string
  /** One line: counts, denominator, rate, distinct learners. */
  summary: string
  reason: string
  subjectKey: string
  source: 'postgres' | 'posthog' | 'fixture'
  lesson?: Reference
  assessment?: Reference
  assessmentFamilyId?: string
  assessmentVersion?: number
  timestampSeconds?: number
  timestampEndSeconds?: number
  window: {start: string; end: string; days: number; key: string; partial: boolean}
  measurement: {
    numerator: number
    numeratorLabel: string
    denominator: number
    denominatorLabel: string
    rate?: number
    distinctLearners: number
  }
  supporting: Array<{_key: string; key: string; label: string; value: number}>
  searchTerms?: string[]
  rule: {text: string; version: string}
  thresholdMet: boolean
  fixture: boolean
  computedAt: string
}

export type ContentSignalDocument = ComputedSignalFields & {_id: string; _type: typeof CONTENT_SIGNAL_TYPE; reviewStatus: 'open'}

export type Mutation =
  | {createIfNotExists: ContentSignalDocument}
  | {patch: {id: string; set: Partial<ComputedSignalFields>; unset?: string[]}}

export function signalTitle(candidate: SignalCandidate): string {
  const base = SIGNAL_TITLES[candidate.type]
  if (candidate.type === 'replay_hotspot' && candidate.timestamp) return `${base} around ${formatClock(candidate.timestamp.startSeconds)}`
  if (candidate.type === 'assessment_difficulty' && candidate.assessment) return `${base} (v${candidate.assessment.version})`
  return base
}

export function signalSummary(candidate: SignalCandidate): string {
  const {numerator, denominator, rate, distinctLearners} = candidate.measurement
  const learners = `${distinctLearners} distinct ${distinctLearners === 1 ? 'person' : 'people'}`
  return `${numerator} of ${denominator} (${percent(rate)}) · ${learners}`
}

export function computedFields(
  candidate: SignalCandidate,
  {window, partial, fixture, computedAt}: {window: SignalWindow; partial: boolean; fixture: boolean; computedAt: Date},
): ComputedSignalFields {
  const fields: ComputedSignalFields = {
    signalType: candidate.type,
    title: fixture ? `[Fixture] ${signalTitle(candidate)}` : signalTitle(candidate),
    summary: signalSummary(candidate),
    reason: candidate.reason,
    subjectKey: candidate.subjectKey,
    source: fixture ? 'fixture' : SIGNAL_SOURCES[candidate.type],
    window: {start: window.start.toISOString(), end: window.end.toISOString(), days: window.days, key: window.key, partial},
    measurement: {
      numerator: candidate.measurement.numerator,
      numeratorLabel: candidate.measurement.numeratorLabel,
      denominator: candidate.measurement.denominator,
      denominatorLabel: candidate.measurement.denominatorLabel,
      ...(candidate.measurement.rate === null ? {} : {rate: candidate.measurement.rate}),
      distinctLearners: candidate.measurement.distinctLearners,
    },
    supporting: candidate.supporting.map((metric) => ({_key: metric.key, ...metric})),
    rule: {text: candidate.rule, version: SIGNAL_RULES_VERSION},
    thresholdMet: candidate.thresholdMet,
    fixture,
    computedAt: computedAt.toISOString(),
  }
  if (candidate.lessonId) fields.lesson = weakRef(candidate.lessonId)
  if (candidate.assessment) {
    fields.assessment = weakRef(candidate.assessment.id)
    fields.assessmentFamilyId = candidate.assessment.familyId
    fields.assessmentVersion = candidate.assessment.version
  }
  if (candidate.timestamp) {
    fields.timestampSeconds = candidate.timestamp.startSeconds
    if (candidate.timestamp.endSeconds !== null) fields.timestampEndSeconds = candidate.timestamp.endSeconds
  }
  if (candidate.searchTerms) fields.searchTerms = candidate.searchTerms
  return fields
}

/** Optional top-level computed fields: unset on a patch when a rerun no longer has them (`set` replaces nested objects whole). */
const OPTIONAL_COMPUTED = ['lesson', 'assessment', 'assessmentFamilyId', 'assessmentVersion', 'timestampSeconds', 'timestampEndSeconds', 'searchTerms'] as const

export type PlannedSignal = {id: string; candidate: SignalCandidate; fields: ComputedSignalFields; action: 'upsert' | 'refresh'}

/**
 * The writes for one window: raised candidates are upserted; candidates below
 * threshold only refresh a document that already exists (so a signal that no
 * longer qualifies says so); the rest write nothing.
 */
export function planSignalWrites(
  candidates: SignalCandidate[],
  options: {window: SignalWindow; partial: boolean; fixture: boolean; computedAt: Date; existingIds: ReadonlySet<string>},
): {planned: PlannedSignal[]; mutations: Mutation[]} {
  const planned: PlannedSignal[] = []
  const mutations: Mutation[] = []
  for (const candidate of candidates) {
    const id = signalDocumentId(candidate.type, candidate.subjectKey, options.window)
    const exists = options.existingIds.has(id)
    if (!candidate.thresholdMet && !exists) continue
    const fields = computedFields(candidate, options)
    const unset = OPTIONAL_COMPUTED.filter((field) => fields[field] === undefined)
    planned.push({id, candidate, fields, action: candidate.thresholdMet ? 'upsert' : 'refresh'})
    if (candidate.thresholdMet) mutations.push({createIfNotExists: {_id: id, _type: CONTENT_SIGNAL_TYPE, reviewStatus: 'open', ...fields}})
    mutations.push({patch: {id, set: fields, ...(unset.length > 0 ? {unset: [...unset]} : {})}})
  }
  return {planned, mutations}
}
