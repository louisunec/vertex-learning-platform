import {resolvedCitationSchema, type ResolvedCitation} from '../ai/contracts.ts'
import type {SourceChunk} from '../evidence/chunks.ts'
import {formatClock} from '../format.ts'
import type {ExistingVersion} from './generate.ts'

/**
 * Source-revision checks for assessment versions (development plan §3
 * "Versioning and consistency"). An item is stale as soon as any chunk it was
 * generated from is missing or has a different revision in the current video
 * record; stale items stop being served until an editor reconciles them.
 */

type ChunkRef = {chunkId?: string | null; chunkRevision?: string | null}

export function isStale(refs: ReadonlyArray<ChunkRef> | null | undefined, current: ReadonlyArray<SourceChunk>): boolean {
  if (!refs || refs.length === 0) return true
  const revisions = new Map(current.map((chunk) => [chunk.chunkId, chunk.chunkRevision]))
  return refs.some((ref) => !ref.chunkId || revisions.get(ref.chunkId) !== ref.chunkRevision)
}

/** Ids (draft or published) of versions not yet marked stale whose sources changed. */
export function findNewlyStale(existing: ReadonlyArray<ExistingVersion>, current: ReadonlyArray<SourceChunk>): string[] {
  return existing.filter((doc) => doc.sourceStatus !== 'stale' && isStale(doc.sourceChunkRefs, current)).map((doc) => doc._id)
}

export type CitationResolution =
  | {status: 'resolved'; citations: ResolvedCitation[]}
  | {status: 'stale'; missing: string[]}

/**
 * Builds citations for stored refs from the current chunk and lesson records
 * — times, label, and href never come from the stored assessment. Any
 * unmatched ref makes the whole set stale rather than partially cited.
 */
export function resolveCitations(
  refs: ReadonlyArray<ChunkRef>,
  lesson: {lessonId: string; lessonSlug: string},
  current: ReadonlyArray<SourceChunk>,
): CitationResolution {
  const byId = new Map(current.map((chunk) => [chunk.chunkId, chunk]))
  const missing = refs
    .filter((ref) => !ref.chunkId || byId.get(ref.chunkId)?.chunkRevision !== ref.chunkRevision)
    .map((ref) => ref.chunkId ?? '')
  if (missing.length > 0 || refs.length === 0) return {status: 'stale', missing}
  const citations = refs.map((ref) => {
    const chunk = byId.get(ref.chunkId!)!
    return resolvedCitationSchema.parse({
      chunkId: chunk.chunkId,
      lessonId: lesson.lessonId,
      sourceRevision: chunk.chunkRevision,
      startSeconds: chunk.startSeconds,
      endSeconds: chunk.endSeconds,
      label: `${formatClock(chunk.startSeconds)}–${formatClock(chunk.endSeconds)}`,
      href: `/lessons/${encodeURIComponent(lesson.lessonSlug)}?t=${chunk.startSeconds}`,
    })
  })
  return {status: 'resolved', citations}
}
