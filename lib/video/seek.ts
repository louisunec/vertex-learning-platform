/**
 * Seek detection for the lesson player (development plan §5 PR-10), so
 * editorial replay signals can tell normal playback, seeking, and replay
 * apart. The YouTube IFrame API reports no seek event, so the player feeds
 * playhead samples (every second while playing, and at every state change)
 * and a seek is a jump of more than `SEEK_JUMP_SECONDS` from where playback
 * would otherwise be. Rapid scrubbing settles into one seek, reported on the
 * first normal sample after it.
 *
 * - `replay`: backward, at most `MAX_REPLAY_SPAN_SECONDS`;
 * - `rewind_far`: further back (a restart, not a replay of one moment);
 * - `skip`: forward.
 *
 * A seek landing within `CITATION_MATCH_SECONDS` of a page-initiated seek
 * (`LessonPlayer.seekTo`, used by tutor citations) made in the last
 * `CITATION_WINDOW_MS` has origin `citation`, so it is never read as
 * learner confusion. The start position (a `?t=` deep link or the resume
 * position) is the first sample, never a seek. Pure and framework-free.
 */

/**
 * The PostHog flag that turns `video_seeked` on (`FLAGS.editorialSignals` in
 * `lib/flags.ts`, which is server-only). The player reads it from posthog-js,
 * whose flags load in the browser on every page anyway, so seek tracking
 * adds no server-side flag evaluation to lesson page renders.
 */
export const SEEK_TRACKING_FLAG = 'editorial-signals'

export const SEEK_JUMP_SECONDS = 2.5
export const MAX_REPLAY_SPAN_SECONDS = 180
export const CITATION_MATCH_SECONDS = 3
export const CITATION_WINDOW_MS = 5_000
/** Bounds analytics volume per page view. */
export const MAX_SEEKS_PER_VIEW = 50

export type SeekKind = 'replay' | 'rewind_far' | 'skip'
export type SeekOrigin = 'learner' | 'citation'
export type Seek = {fromSeconds: number; toSeconds: number; kind: SeekKind; origin: SeekOrigin}

export type ProgrammaticSeek = {seconds: number; at: number}

type Sample = {position: number; at: number; playing: boolean; rate: number}

export function classifySeek(fromSeconds: number, toSeconds: number): SeekKind {
  if (toSeconds > fromSeconds) return 'skip'
  return fromSeconds - toSeconds <= MAX_REPLAY_SPAN_SECONDS ? 'replay' : 'rewind_far'
}

export class SeekTracker {
  private last: Sample | null = null
  private pending: {from: number; to: number; at: number} | null = null
  private emitted = 0
  private readonly programmatic: () => ProgrammaticSeek | null

  constructor(programmatic: () => ProgrammaticSeek | null = () => null) {
    this.programmatic = programmatic
  }

  /**
   * Records a playhead sample. `playing` is whether playback continues from
   * this sample (false at pause, buffering, or end). Returns a seek once one
   * has settled.
   */
  sample(position: number, at: number, {playing, rate = 1}: {playing: boolean; rate?: number}): Seek | null {
    if (!Number.isFinite(position) || position < 0) return null
    const previous = this.last
    this.last = {position, at, playing, rate: Number.isFinite(rate) && rate > 0 ? rate : 1}
    if (!previous) return null

    const expected = previous.playing ? previous.position + ((at - previous.at) / 1000) * previous.rate : previous.position
    if (Math.abs(position - expected) > SEEK_JUMP_SECONDS) {
      this.pending = {from: this.pending?.from ?? Math.max(0, expected), to: position, at: this.pending?.at ?? at}
      return null
    }
    return this.settle()
  }

  /** Reports a seek still waiting to settle (on end or unmount). */
  flush(): Seek | null {
    return this.settle()
  }

  private settle(): Seek | null {
    const pending = this.pending
    this.pending = null
    if (!pending || this.emitted >= MAX_SEEKS_PER_VIEW) return null
    if (Math.abs(pending.to - pending.from) <= SEEK_JUMP_SECONDS) return null
    this.emitted++
    const page = this.programmatic()
    const citation = page !== null && pending.at - page.at <= CITATION_WINDOW_MS && pending.at >= page.at - 1_000 && Math.abs(pending.to - page.seconds) <= CITATION_MATCH_SECONDS
    return {
      fromSeconds: Math.floor(pending.from),
      toSeconds: Math.floor(pending.to),
      kind: classifySeek(pending.from, pending.to),
      origin: citation ? 'citation' : 'learner',
    }
  }
}
