import type {SourceChunk} from '../evidence/chunks.ts'

/**
 * Bounded source spans for offline assessment generation (development plan
 * §5 PR-1). A model call only ever sees one span — never a whole transcript
 * (AGENTS.md §2). Spans follow chapter boundaries when chapters exist and
 * fixed windows otherwise; the result is deterministic for the same input.
 */

/** Hard cap per span: at `MAX_CHUNK_CHARS` (300) this is ≈3,600 characters of source. */
export const MAX_SPAN_CHUNKS = 12
/** Window size when a video has no chapters. */
export const WINDOW_CHUNKS = 10
/** Spans smaller than this merge into the previous span of the same chapter when the result stays within the cap. */
export const MIN_SPAN_CHUNKS = 3

export type Span = {
  /** Position in the lesson's span list; part of the assessment family id. */
  index: number
  chapterLabel: string | null
  chunks: SourceChunk[]
  startSeconds: number
  endSeconds: number
}

type Group = {chapterLabel: string | null; chunks: SourceChunk[]}

export function buildSpans(
  chunks: ReadonlyArray<SourceChunk>,
  chapters: ReadonlyArray<{startSeconds: number; label: string}> = [],
): Span[] {
  if (chunks.length === 0) return []
  const validChapters = chapters
    .filter((chapter) => Number.isInteger(chapter.startSeconds) && chapter.startSeconds >= 0 && chapter.label?.trim())
    .toSorted((a, b) => a.startSeconds - b.startSeconds)

  const pieces =
    validChapters.length > 0
      ? groupByChapter(chunks, validChapters).flatMap(splitEvenly)
      : splitWindows({chapterLabel: null, chunks: [...chunks]})

  const merged: Group[] = []
  for (const piece of pieces) {
    const previous = merged.at(-1)
    if (
      previous &&
      previous.chapterLabel === piece.chapterLabel &&
      piece.chunks.length < MIN_SPAN_CHUNKS &&
      previous.chunks.length + piece.chunks.length <= MAX_SPAN_CHUNKS
    ) {
      previous.chunks.push(...piece.chunks)
    } else {
      merged.push({chapterLabel: piece.chapterLabel, chunks: [...piece.chunks]})
    }
  }

  return merged.map((group, index) => ({
    index,
    chapterLabel: group.chapterLabel,
    chunks: group.chunks,
    startSeconds: group.chunks[0].startSeconds,
    endSeconds: group.chunks.at(-1)!.endSeconds,
  }))
}

/** Assigns each chunk to the last chapter starting at or before it (the first chapter takes any earlier chunks). */
function groupByChapter(
  chunks: ReadonlyArray<SourceChunk>,
  chapters: ReadonlyArray<{startSeconds: number; label: string}>,
): Group[] {
  const groups: Group[] = chapters.map((chapter) => ({chapterLabel: chapter.label.trim(), chunks: []}))
  for (const chunk of chunks) {
    let target = 0
    for (let i = 0; i < chapters.length; i++) {
      if (chapters[i].startSeconds <= chunk.startSeconds) target = i
    }
    groups[target].chunks.push(chunk)
  }
  return groups.filter((group) => group.chunks.length > 0)
}

/** Splits an over-long chapter into the fewest near-equal pieces within the cap. */
function splitEvenly(group: Group): Group[] {
  const count = Math.ceil(group.chunks.length / MAX_SPAN_CHUNKS)
  const size = Math.ceil(group.chunks.length / count)
  return chunked(group, size)
}

function splitWindows(group: Group): Group[] {
  return chunked(group, WINDOW_CHUNKS)
}

function chunked(group: Group, size: number): Group[] {
  const out: Group[] = []
  for (let i = 0; i < group.chunks.length; i += size) {
    out.push({chapterLabel: group.chapterLabel, chunks: group.chunks.slice(i, i + size)})
  }
  return out
}
