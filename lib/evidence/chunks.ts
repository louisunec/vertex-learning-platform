import {createHash} from 'node:crypto'

import {MAX_CHUNK_SECONDS} from '../video/ingest.ts'

/**
 * Shared source-chunk identity (development plan §3 "Versioning and
 * consistency"). Every feature that stores or resolves an `EvidenceRef`
 * (`lib/ai/contracts.ts`) derives `chunkId` and `chunkRevision` here, so
 * assessments, tutor citations, and concepts agree on what a chunk is.
 *
 * Both values are computed from stored `video` records rather than stored on
 * them: identical re-ingested captions keep their revision, changed text gets
 * a new one, and a shifted chunk key reads (conservatively) as a new chunk.
 * Visual chunks (OCR/VLM, stored on `videoVisualIndex`) follow the same rule
 * with their own revision inputs; transcript identity is unchanged.
 * Framework-free so offline tooling and `node --test` can load it.
 */

/**
 * Where a chunk's text came from. `ocr` and `vlm` chunks come from a video's
 * visual index (PR-2); a `vlm` chunk is a model interpretation, never ground
 * truth. OCR and VLM text is untrusted data like transcript text.
 */
export const EVIDENCE_SOURCES = ['transcript', 'ocr', 'vlm'] as const
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number]
export type VisualSource = Exclude<EvidenceSource, 'transcript'>

/** A transcript chunk as stored on a `video` document. */
export type StoredChunk = {
  _key: string
  startSeconds: number
  text: string
}

/** A source chunk with its evidence identity and time range. */
export type SourceChunk = {
  chunkId: string
  chunkRevision: string
  source: EvidenceSource
  startSeconds: number
  endSeconds: number
  text: string
}

/** A visual chunk as stored on a `videoVisualIndex` document. */
export type StoredVisualChunk = {
  _key: string
  source: VisualSource
  startSeconds: number
  endSeconds: number
  text: string
}

/** Hex characters kept from each sha256 digest. */
const REVISION_LENGTH = 16

/** Stable id of one chunk: `<video document id>:<chunk _key>`. */
export function chunkIdFor(videoDocumentId: string, chunkKey: string): string {
  return `${videoDocumentId}:${chunkKey}`
}

/** Content revision of one chunk: changes whenever its start or text changes. */
export function chunkRevisionOf(chunk: {startSeconds: number; text: string}): string {
  return hashParts([String(chunk.startSeconds), chunk.text]).slice(0, REVISION_LENGTH)
}

/** sha256 over ordered parts; the separator keeps `["ab","c"]` and `["a","bc"]` distinct. */
export function hashParts(parts: ReadonlyArray<string>): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex')
}

/**
 * Valid stored chunks in time order with ids, revisions, and end times. A
 * chunk ends where the next begins; the last ends at the video duration or
 * `MAX_CHUNK_SECONDS` after its start, whichever is sooner.
 */
export function toSourceChunks(video: {
  _id: string
  durationSeconds?: number | null
  transcriptChunks?: ReadonlyArray<Partial<StoredChunk>> | null
}): SourceChunk[] {
  const valid = (video.transcriptChunks ?? [])
    .filter(
      (chunk): chunk is StoredChunk =>
        typeof chunk._key === 'string' &&
        chunk._key.length > 0 &&
        Number.isInteger(chunk.startSeconds) &&
        (chunk.startSeconds as number) >= 0 &&
        typeof chunk.text === 'string' &&
        chunk.text.trim().length > 0,
    )
    .toSorted((a, b) => a.startSeconds - b.startSeconds)

  const duration =
    typeof video.durationSeconds === 'number' && Number.isFinite(video.durationSeconds)
      ? Math.floor(video.durationSeconds)
      : null

  return valid.map((chunk, i) => {
    const next = valid[i + 1]
    const end = next
      ? next.startSeconds
      : Math.min(chunk.startSeconds + MAX_CHUNK_SECONDS, duration ?? Number.POSITIVE_INFINITY)
    return {
      chunkId: chunkIdFor(video._id, chunk._key),
      chunkRevision: chunkRevisionOf(chunk),
      source: 'transcript',
      startSeconds: chunk.startSeconds,
      endSeconds: Math.max(chunk.startSeconds, end),
      text: chunk.text,
    }
  })
}

/** Id of a video's visual index document: `visual-<video document id>`. */
export function visualIndexIdFor(videoDocumentId: string): string {
  return `visual-${videoDocumentId}`
}

/**
 * Content revision of one visual chunk. Unlike transcript chunks it covers
 * the stored end time and the extraction version, so re-extracting with a
 * changed sampler, OCR engine, or merge rule reads as new evidence.
 */
export function visualChunkRevisionOf(
  chunk: {source: VisualSource; startSeconds: number; endSeconds: number; text: string},
  extractionVersion: string,
): string {
  return hashParts([
    chunk.source,
    String(chunk.startSeconds),
    String(chunk.endSeconds),
    chunk.text,
    extractionVersion,
  ]).slice(0, REVISION_LENGTH)
}

/**
 * Valid stored visual chunks in time order with ids and revisions. Chunk ids
 * use the visual index document id (`<visual index id>:<chunk _key>`). An
 * index without an extraction version has no citable chunks.
 */
export function toVisualSourceChunks(index: {
  _id: string
  extractionVersion?: string | null
  chunks?: ReadonlyArray<Partial<StoredVisualChunk>> | null
}): SourceChunk[] {
  const extractionVersion = index.extractionVersion
  if (typeof extractionVersion !== 'string' || extractionVersion.length === 0) return []
  return (index.chunks ?? [])
    .filter(
      (chunk): chunk is StoredVisualChunk =>
        typeof chunk._key === 'string' &&
        chunk._key.length > 0 &&
        (chunk.source === 'ocr' || chunk.source === 'vlm') &&
        Number.isInteger(chunk.startSeconds) &&
        (chunk.startSeconds as number) >= 0 &&
        Number.isInteger(chunk.endSeconds) &&
        (chunk.endSeconds as number) >= (chunk.startSeconds as number) &&
        typeof chunk.text === 'string' &&
        chunk.text.trim().length > 0,
    )
    .toSorted((a, b) => a.startSeconds - b.startSeconds || a._key.localeCompare(b._key))
    .map((chunk) => ({
      chunkId: chunkIdFor(index._id, chunk._key),
      chunkRevision: visualChunkRevisionOf(chunk, extractionVersion),
      source: chunk.source,
      startSeconds: chunk.startSeconds,
      endSeconds: chunk.endSeconds,
      text: chunk.text,
    }))
}
