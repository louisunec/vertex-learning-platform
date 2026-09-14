/**
 * Display formatting for stored values. Every helper is a pure derivation of
 * data that already exists; none of them invent a value when input is missing.
 */

/** `18h 24m`, `1h 12m`, `45m`, `50s` — long-form duration for course/module totals. */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds))
  if (seconds < 60) return `${seconds}s`
  let hours = Math.floor(seconds / 3600)
  let minutes = Math.round((seconds % 3600) / 60)
  if (minutes === 60) {
    hours += 1
    minutes = 0
  }
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}

/** `12:45`, `1:02:03` — clock-style duration for a single lesson video. `pad` gives `05:41`. */
export function formatClock(totalSeconds: number, {pad = false}: {pad?: boolean} = {}): string {
  const seconds = Math.max(0, Math.round(totalSeconds))
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  const mm = h > 0 || pad ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}

/** Stored level enum (`intermediate`) → display label (`Intermediate`). */
export function formatLevel(level: string): string {
  return level.charAt(0).toUpperCase() + level.slice(1)
}

/** `12 modules`, `1 module` */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

const RELATIVE_UNITS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 86400],
  ['month', 30 * 86400],
  ['week', 7 * 86400],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
]

const relativeTime = new Intl.RelativeTimeFormat('en', {numeric: 'always'})

/** `2 hours ago`, `1 day ago`; `just now` under a minute or for a timestamp ahead of `now`. */
export function formatRelativeTime(at: string | Date, now: Date): string {
  const seconds = Math.floor((now.getTime() - new Date(at).getTime()) / 1000)
  for (const [unit, size] of RELATIVE_UNITS) {
    if (seconds >= size) return relativeTime.format(-Math.floor(seconds / size), unit)
  }
  return 'just now'
}
