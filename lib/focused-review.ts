import type {ReviewReason, ReviewSessionResponse} from './learner/contracts.ts'

/**
 * View model for My Learning → Reviews (prompts/focused-review.md). Pure:
 * the session comes from `/api/review-session`, and `closed` holds the
 * positions already answered or no longer answerable (from the server on
 * load, then from this page's own graded answers).
 */

export type ActiveReview = Extract<ReviewSessionResponse, {status: 'active'}>

/** The chip beside the concept name; grounded in the learner's own latest counted answer, never a schedule. */
export const REASON_CHIPS: Record<ReviewReason, string> = {
  independent_incorrect: 'Missed last time',
  assisted_incorrect: 'Missed with help',
  assisted_correct: 'Answered with help',
}

/** "Why this review?" for the current concept. */
export const REASON_TEXT: Record<ReviewReason, string> = {
  independent_incorrect: 'This concept is ready for another independent attempt — your last answer on your own was incorrect.',
  assisted_incorrect: 'This concept is ready for another independent attempt — your last answer used help and was incorrect.',
  assisted_correct: 'This concept is ready for another independent attempt — your last correct answer used help.',
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
