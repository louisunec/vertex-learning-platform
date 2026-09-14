/**
 * Measurement windows for editorial signals: fixed, half-open UTC intervals
 * `[start, end)` aligned to a Monday anchor, so the same window always has
 * the same bounds and key and a rerun recomputes exactly the same rows.
 */

const DAY_MS = 24 * 60 * 60 * 1000

/** Monday 2026-01-05 00:00 UTC; every window starts a whole number of window lengths from it. */
export const WINDOW_ANCHOR_MS = Date.UTC(2026, 0, 5)

export const MIN_WINDOW_DAYS = 1
export const MAX_WINDOW_DAYS = 28
export const DEFAULT_WINDOW_DAYS = 7

export type SignalWindow = {start: Date; end: Date; days: number; key: string}

function yyyymmdd(date: Date): string {
  return date.toISOString().slice(0, 10).replaceAll('-', '')
}

export function assertWindowDays(days: number): void {
  if (!Number.isInteger(days) || days < MIN_WINDOW_DAYS || days > MAX_WINDOW_DAYS) {
    throw new RangeError(`Window length must be a whole number of days between ${MIN_WINDOW_DAYS} and ${MAX_WINDOW_DAYS}`)
  }
}

/** The window of `days` length that contains `instant` (an instant on a boundary starts the next window). */
export function windowContaining(instant: Date, days: number): SignalWindow {
  assertWindowDays(days)
  const length = days * DAY_MS
  const index = Math.floor((instant.getTime() - WINDOW_ANCHOR_MS) / length)
  const start = new Date(WINDOW_ANCHOR_MS + index * length)
  const end = new Date(start.getTime() + length)
  return {start, end, days, key: `${yyyymmdd(start)}-${days}d`}
}

/**
 * Windows a run processes, oldest first: the last completed window before
 * `now`, `lookback` earlier ones (late-arriving events), and, with
 * `includeCurrent`, the window still in progress (marked partial by the caller).
 */
export function windowsToProcess({
  now,
  days = DEFAULT_WINDOW_DAYS,
  lookback = 1,
  includeCurrent = false,
}: {
  now: Date
  days?: number
  lookback?: number
  includeCurrent?: boolean
}): SignalWindow[] {
  const current = windowContaining(now, days)
  const windows: SignalWindow[] = []
  for (let back = Math.max(0, lookback) + 1; back >= 1; back--) {
    windows.push(windowContaining(new Date(current.start.getTime() - back * days * DAY_MS), days))
  }
  if (includeCurrent) windows.push(current)
  return windows
}

/** Whether a window has not ended yet at `now`. */
export function isPartial(window: SignalWindow, now: Date): boolean {
  return window.end.getTime() > now.getTime()
}
