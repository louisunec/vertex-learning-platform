import type {ResolvedCitation} from '../ai/contracts.ts'
import {formatClock} from '../format.ts'

/**
 * Citation buttons for tutor statements (development plan §5 PR-7). Framework
 * free so `node --test` covers it. Citations of one statement that share a
 * lesson and are contiguous (each starts at or before the previous one's
 * `endSeconds`, the rule `tutorStatementSchema` documents) show as one time
 * range seeking to the first start; every chunk id is kept, in order.
 */

export type CitationGroup = {
  lessonId: string
  startSeconds: number
  endSeconds: number
  /** The first citation's server-built label and href (`/lessons/<slug>?t=<start>`). */
  label: string
  href: string
  chunkIds: string[]
}

export function groupCitations(citations: readonly ResolvedCitation[]): CitationGroup[] {
  const groups: CitationGroup[] = []
  let previous: ResolvedCitation | null = null
  for (const citation of citations) {
    const last = groups.at(-1)
    if (last && previous && previous.lessonId === citation.lessonId && citation.startSeconds <= previous.endSeconds) {
      last.endSeconds = Math.max(last.endSeconds, citation.endSeconds)
      last.chunkIds.push(citation.chunkId)
    } else {
      groups.push({
        lessonId: citation.lessonId,
        startSeconds: citation.startSeconds,
        endSeconds: citation.endSeconds,
        label: citation.label,
        href: citation.href,
        chunkIds: [citation.chunkId],
      })
    }
    previous = citation
  }
  return groups
}

/** Button text: a time range in this lesson, or the other lesson's label (title · start). */
export function citationText(group: CitationGroup, currentLessonId: string): string {
  if (group.lessonId !== currentLessonId) return group.label
  const start = formatClock(group.startSeconds)
  const end = formatClock(group.endSeconds)
  return start === end ? start : `${start}–${end}`
}
