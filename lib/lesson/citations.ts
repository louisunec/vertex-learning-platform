import type {ResolvedCitation} from '../ai/contracts.ts'
import {formatClock} from '../format.ts'

/**
 * Citation buttons for tutor statements (development plan §5 PR-7). Framework
 * free so `node --test` covers it. Citations of one statement that share a
 * lesson and a source and are contiguous (each starts at or before the
 * previous one's `endSeconds`, the rule `tutorStatementSchema` documents)
 * show as one time range seeking to the first start; every chunk id is kept,
 * in order.
 */

/** What a citation button says it points at: spoken words, or what is on screen. */
export type CitationKind = 'transcript' | 'visual'

export type CitationGroup = {
  lessonId: string
  kind: CitationKind
  startSeconds: number
  endSeconds: number
  /** The first citation's server-built label and href (`/lessons/<slug>?t=<start>`). */
  label: string
  href: string
  chunkIds: string[]
}

/**
 * A resolved citation with the evidence modality PR-2 adds to the contract
 * (`resolvedCitationSchema.source`, optional). Declared here so this module
 * reads it on stacks with and without PR-2; without it every citation is a
 * transcript citation.
 */
export type SourcedCitation = ResolvedCitation & {source?: 'transcript' | 'ocr' | 'vlm'}

/**
 * `visual` only for a server-validated citation of on-screen evidence (`ocr`
 * or `vlm`); an absent source predates visual evidence and is a transcript.
 */
export function citationKind(citation: SourcedCitation): CitationKind {
  return citation.source === 'ocr' || citation.source === 'vlm' ? 'visual' : 'transcript'
}

export function groupCitations(citations: readonly SourcedCitation[]): CitationGroup[] {
  const groups: CitationGroup[] = []
  let previous: SourcedCitation | null = null
  for (const citation of citations) {
    const last = groups.at(-1)
    const kind = citationKind(citation)
    if (
      last &&
      previous &&
      previous.lessonId === citation.lessonId &&
      last.kind === kind &&
      citation.startSeconds <= previous.endSeconds
    ) {
      last.endSeconds = Math.max(last.endSeconds, citation.endSeconds)
      last.chunkIds.push(citation.chunkId)
    } else {
      groups.push({
        lessonId: citation.lessonId,
        kind,
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
