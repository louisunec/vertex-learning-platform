import type {AttemptSchedule, ReviewItem, ReviewReason, ReviewSessionResponse, SCHEDULED_DUE} from './learner/contracts.ts'

/**
 * View model for My Learning → Reviews (prompts/focused-review.md,
 * prompts/pr-9-scheduled-review.md). Pure: the session comes from
 * `/api/review-session`, and `closed` holds the positions already answered or
 * no longer answerable (from the server on load, then from this page's own
 * graded answers).
 */

export type AnyReviewReason = ReviewReason | typeof SCHEDULED_DUE

/**
 * An active session of either mode. Scheduled sessions add `mode`, the count
 * of due cards left out for lack of a question, and `repeat` on open items.
 */
export type ActiveReview = Omit<Extract<ReviewSessionResponse, {status: 'active'}>, 'concepts' | 'items'> & {
  concepts: Array<{conceptId: string; name: string | null; reason: AnyReviewReason}>
  items: Array<ReviewItem & {repeat?: boolean}>
  mode?: 'scheduled'
  unavailableDue?: number
}

/**
 * The chip beside the concept name: in Mistakes mode grounded in the
 * learner's own latest counted answer, in Scheduled mode in their stored
 * review schedule.
 */
export const REASON_CHIPS: Record<AnyReviewReason, string> = {
  independent_incorrect: 'Missed last time',
  assisted_incorrect: 'Missed with help',
  assisted_correct: 'Answered with help',
  scheduled_due: 'Due for review',
}

/** "Why this review?" for the current concept. */
export const REASON_TEXT: Record<AnyReviewReason, string> = {
  independent_incorrect: 'This concept is ready for another independent attempt — your last answer on your own was incorrect.',
  assisted_incorrect: 'This concept is ready for another independent attempt — your last answer used help and was incorrect.',
  assisted_correct: 'This concept is ready for another independent attempt — your last correct answer used help.',
  scheduled_due: 'Your review schedule says this is due — a quick check that you still remember it without help.',
}

/** A stored due date in the viewer's own locale and time zone (the server never decides "today"). */
export function formatDueDate(iso: string, locale?: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, {dateStyle: 'medium', timeStyle: 'short', timeZone}).format(new Date(iso))
}

/** What an answer did to the learner's schedule, when the server reported it. */
export function scheduleText(schedule: AttemptSchedule, locale?: string, timeZone?: string): string {
  return schedule.status === 'scheduled'
    ? `Next review: ${formatDueDate(schedule.dueAt, locale, timeZone)}.`
    : 'You used help on this one, so it doesn’t change your review schedule. Answering it later without help will.'
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

/** "3 concepts · 5 questions": counts of what the server issued, never an estimate of time. */
export function sessionSummary(session: ActiveReview): string {
  return `${plural(session.concepts.length, 'concept')} · ${plural(session.items.length, 'question')}`
}

/** Positions of the session's items that closed on the server: answered, withdrawn, or changed. */
export function closedOnLoad(session: ActiveReview): Set<number> {
  return new Set(session.items.filter((item) => item.state !== 'open').map((item) => item.position))
}

/** The first open position after `after` (0 = from the start), or null when none is left. */
export function nextOpenPosition(session: ActiveReview, closed: ReadonlySet<number>, after = 0): number | null {
  return session.items.find((item) => item.position > after && item.state === 'open' && !closed.has(item.position))?.position ?? null
}

export type ConceptProgress = {
  conceptId: string
  name: string | null
  status: 'current' | 'next' | 'done'
  label: string
}

/** Each concept's place in the session: the one being asked, finished, or still to come. */
export function conceptProgress(session: ActiveReview, closed: ReadonlySet<number>, current: number | null): ConceptProgress[] {
  const total = session.items.length
  return session.concepts.map(({conceptId, name}) => {
    const positions = session.items.filter((item) => item.conceptId === conceptId).map((item) => item.position)
    if (current !== null && positions.includes(current)) {
      return {conceptId, name, status: 'current', label: `Current · question ${current} of ${total}`}
    }
    if (positions.every((position) => closed.has(position))) return {conceptId, name, status: 'done', label: 'Done'}
    return {conceptId, name, status: 'next', label: 'Next'}
  })
}
