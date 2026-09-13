/**
 * Which help buttons the lesson page offers (development plan §5 PR-7), for
 * both the check and the tutor. The server decides and records the level
 * (PR-5); these only choose which requests to offer.
 *
 * "Another hint" is `escalate` and appears only at level 1: at level 2 the
 * next step is the solution itself, so the only offer is "Show the
 * explanation" (`solution`) — a one-step escalation is never labelled as a
 * full answer, and a full answer is never labelled as a hint.
 */

export type HelpActionRequest = 'hint' | 'escalate' | 'solution'

export type HelpAction = {request: HelpActionRequest; label: string}

const FIRST_HINT: HelpAction = {request: 'hint', label: 'Get a hint'}
const ANOTHER_HINT: HelpAction = {request: 'escalate', label: 'Another hint'}
const EXPLANATION: HelpAction = {request: 'solution', label: 'Show the explanation'}

export function helpActions({
  level,
  answered = false,
  correct = false,
}: {
  /** Highest level delivered so far on this task or tutor thread (0 = none). */
  level: 0 | 1 | 2 | 3
  /** The check question was already graded: only the explanation remains useful, and only after a miss. */
  answered?: boolean
  correct?: boolean
}): HelpAction[] {
  if (level >= 3) return []
  if (answered) return correct ? [] : [EXPLANATION]
  if (level === 0) return [FIRST_HINT]
  if (level === 1) return [ANOTHER_HINT, EXPLANATION]
  return [EXPLANATION]
}

/** Tutor follow-ups after an answer at `level`; a clarifying question (0) is answered by rephrasing. */
export function tutorHelpActions(level: 0 | 1 | 2 | 3): HelpAction[] {
  return level === 0 ? [] : helpActions({level})
}
