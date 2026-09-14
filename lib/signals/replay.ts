import {formatClock} from '../format.ts'
import {rate, percent, type SignalCandidate} from './candidate.ts'
import type {SignalThresholds} from './config.ts'
import type {AnalyticsEvent} from './posthog-reader.ts'

/**
 * Replay hotspots from the lesson player's `video_seeked` events
 * (`lib/video/seek.ts`), aggregated per lesson, video, and target bucket.
 *
 * Counted: learner-initiated backward seeks of at most `MAX_REPLAY_SPAN`
 * seconds (`seek_kind = 'replay'`, `seek_origin = 'learner'`). Excluded:
 * forward skips, far rewinds (restarts), and seeks made by the page itself
 * (tutor citation jumps, `seek_origin = 'citation'`). Deep links and resume
 * positions set the embed's start second and are never seeks. Each person
 * counts once per bucket however often they replay it.
 *
 * Denominator: distinct people who played the lesson's video in the window
 * with seek tracking on (`video_played.seek_tracking`, decided once per page
 * view by the `editorial-signals` flag in the browser). Views without seek
 * tracking could never report a replay, so they are left out of the
 * denominator rather than diluting the share. A replay is a potential sign of friction or of interest; it never shows
 * that the teaching is unclear.
 */

export const SEEK_PROPERTIES = ['lesson_id', 'video_id', 'from_seconds', 'to_seconds', 'seek_kind', 'seek_origin'] as const
export const PLAY_PROPERTIES = ['lesson_id', 'video_id', 'seek_tracking'] as const

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

const num = (value: unknown): number | null => {
  const parsed = typeof value === 'string' ? Number(value) : value
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}
const id = (value: unknown): string | null => (typeof value === 'string' && ID.test(value) ? value : null)
/** HogQL may return a boolean property as a JSON boolean or as the string `"true"`. */
const tracked = (value: unknown): boolean => value === true || value === 'true'

export type ReplayReport = {
  candidates: SignalCandidate[]
  excluded: {citation: number; skip: number; rewind_far: number; invalid: number; untracked_plays: number}
}

export function aggregateReplayHotspots({
  seeks,
  plays,
  thresholds,
}: {
  seeks: AnalyticsEvent[]
  plays: AnalyticsEvent[]
  thresholds: SignalThresholds['replay']
}): ReplayReport {
  const excluded = {citation: 0, skip: 0, rewind_far: 0, invalid: 0, untracked_plays: 0}
  const viewers = new Map<string, Set<string>>()
  const addViewer = (video: string, person: string) => viewers.set(video, (viewers.get(video) ?? new Set()).add(person))

  for (const play of plays) {
    if (!tracked(play.properties.seek_tracking)) {
      excluded.untracked_plays++
      continue
    }
    const lesson = id(play.properties.lesson_id)
    const video = id(play.properties.video_id)
    if (lesson && video) addViewer(`${lesson}|${video}`, play.personId)
  }

  const buckets = new Map<string, {lesson: string; video: string; bucket: number; people: Set<string>; events: number; citations: number}>()
  const seen = new Set<string>()
  for (const seek of seeks) {
    if (seen.has(seek.uuid)) continue
    seen.add(seek.uuid)
    const lesson = id(seek.properties.lesson_id)
    const video = id(seek.properties.video_id)
    const to = num(seek.properties.to_seconds)
    if (!lesson || !video || to === null) {
      excluded.invalid++
      continue
    }
    const bucket = Math.floor(to / thresholds.bucketSeconds) * thresholds.bucketSeconds
    const key = `${lesson}|${video}|${bucket}`
    const entry = buckets.get(key) ?? {lesson, video, bucket, people: new Set<string>(), events: 0, citations: 0}
    if (seek.properties.seek_origin !== 'learner') {
      excluded.citation++
      entry.citations++
      buckets.set(key, entry)
      continue
    }
    const kind = seek.properties.seek_kind
    if (kind === 'skip' || kind === 'rewind_far') {
      excluded[kind]++
      continue
    }
    if (kind !== 'replay') {
      excluded.invalid++
      continue
    }
    entry.people.add(seek.personId)
    entry.events++
    buckets.set(key, entry)
    // Someone who replayed the video also watched it, even if their play event fell in an earlier window.
    addViewer(`${lesson}|${video}`, seek.personId)
  }

  const rule = `Raised when at least ${thresholds.minPeople} distinct people, and at least ${percent(thresholds.minShareOfViewers)} of the video's viewers in the window, jump back to replay the same ${thresholds.bucketSeconds}-second stretch. Citation jumps, skips, and restarts are excluded.`
  const candidates: SignalCandidate[] = []
  for (const entry of buckets.values()) {
    if (entry.people.size === 0) continue
    const audience = viewers.get(`${entry.lesson}|${entry.video}`)?.size ?? entry.people.size
    const share = rate(entry.people.size, audience)
    const thresholdMet = entry.people.size >= thresholds.minPeople && share !== null && share >= thresholds.minShareOfViewers
    const at = formatClock(entry.bucket)
    candidates.push({
      type: 'replay_hotspot',
      subjectKey: `${entry.lesson}|${entry.video}|${entry.bucket}`,
      thresholdMet,
      reason: thresholdMet
        ? `${entry.people.size} of ${audience} viewers (${percent(share)}) jumped back to replay the stretch starting at ${at}. Replays can signal friction or interest; they do not show that the teaching is unclear.`
        : `${entry.people.size} of ${audience} viewers replayed the stretch starting at ${at}; below the threshold.`,
      lessonId: entry.lesson,
      assessment: null,
      timestamp: {startSeconds: entry.bucket, endSeconds: entry.bucket + thresholds.bucketSeconds},
      measurement: {
        numerator: entry.people.size,
        numeratorLabel: 'People who replayed this stretch',
        denominator: audience,
        denominatorLabel: "People who played this lesson's video with seek tracking on, in the window",
        rate: share,
        distinctLearners: entry.people.size,
      },
      supporting: [
        {key: 'replay_events', label: 'Replay seeks into this stretch (repeats included)', value: entry.events},
        {key: 'citation_jumps', label: 'Tutor citation jumps into this stretch (excluded)', value: entry.citations},
      ],
      searchTerms: null,
      rule,
    })
  }
  return {candidates, excluded}
}
