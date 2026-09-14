/**
 * Help buttons under a submission review (development plan §5 PR-12). The
 * server decides and records the level (PR-5); these only choose which
 * requests to offer. "Explain the issues" is one step up; "Show corrections"
 * is the explicit request for the full answer, so it is offered from the
 * start and never labelled as a hint.
 */

export type ReviewHelpRequestKind = 'escalate' | 'solution'

export type ReviewHelpAction = {request: ReviewHelpRequestKind; label: string}

const EXPLAIN: ReviewHelpAction = {request: 'escalate', label: 'Explain the issues'}
const CORRECTIONS: ReviewHelpAction = {request: 'solution', label: 'Show corrections'}

export function reviewHelpActions({level, helpWorthy}: {level: 0 | 1 | 2 | 3; helpWorthy: boolean}): ReviewHelpAction[] {
  if (!helpWorthy || level >= 3) return []
  return level === 2 ? [CORRECTIONS] : [EXPLAIN, CORRECTIONS]
}
