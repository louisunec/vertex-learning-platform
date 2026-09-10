import {z} from 'zod'

import type {ParsedVideo} from './provider.ts'

/**
 * Pure ingestion logic for the offline video pipeline (VIDEO_PIPELINE §5–§6):
 * caption-event normalization, transcript chunking, description-chapter
 * parsing, and the validated `video` document builder. Framework-free — the
 * CLI in `scripts/ingest-videos.mts` does the network/datastore I/O.
 */

export type CaptionEvent = {
  startMs: number
  text: string
}

export type Chapter = {
  startSeconds: number
  label: string
}

export type TranscriptChunk = {
  startSeconds: number
  text: string
}

/**
 * Chunk close thresholds: long enough that a matched chunk carries usable
 * local context, short enough that `startSeconds` still lands the learner at
 * the moment (spoken English ≈ 2.5 words/s, so ≤30 s ≈ ≤75 words). A chunk
 * closes at whichever limit is hit first.
 */
export const MAX_CHUNK_SECONDS = 30
export const MAX_CHUNK_CHARS = 300

const second = z.number().int().nonnegative()

/** Shape written by the ingestion tool — mirrors `studio/schemaTypes/documents/video.ts`. */
export const videoDocumentSchema = z.object({
  _id: z.string().min(1),
  _type: z.literal('video'),
  videoId: z.string().min(1),
  provider: z.enum(['youtube', 'vimeo', 'bunny']),
  providerVideoId: z.string().min(1),
  sourceUrl: z.url(),
  title: z.string().min(1).optional(),
  durationSeconds: second.optional(),
  chapters: z
    .array(z.object({_key: z.string().min(1), startSeconds: second, label: z.string().min(1)}))
    .optional(),
  transcriptChunks: z
    .array(z.object({_key: z.string().min(1), startSeconds: second, text: z.string().min(1)}))
    .optional(),
  ingestedAt: z.iso.datetime(),
})

export type VideoDocument = z.infer<typeof videoDocumentSchema>

/**
 * Normalizes YouTube `fmt=json3` caption payloads into ordered events.
 * Skips windowing/append events without spoken text (ASR tracks interleave
 * `aAppend` newline events between segments).
 */
export function parseJson3Captions(raw: unknown): CaptionEvent[] {
  if (typeof raw !== 'object' || raw === null) return []
  const events = (raw as {events?: unknown}).events
  if (!Array.isArray(events)) return []
  const out: CaptionEvent[] = []
  for (const event of events) {
    if (typeof event !== 'object' || event === null) continue
    const {tStartMs, segs, aAppend} = event as {tStartMs?: unknown; segs?: unknown; aAppend?: unknown}
    if (aAppend === 1 || typeof tStartMs !== 'number' || !Array.isArray(segs)) continue
    const text = collapseWhitespace(
      segs.map((seg) => (typeof (seg as {utf8?: unknown})?.utf8 === 'string' ? (seg as {utf8: string}).utf8 : '')).join(''),
    )
    if (!text) continue
    out.push({startMs: Math.max(0, tStartMs), text})
  }
  return out.sort((a, b) => a.startMs - b.startMs)
}

/**
 * Merges consecutive caption events into short timestamped chunks
 * (VIDEO_PIPELINE §6). `startSeconds` is the whole second of the chunk's
 * first event, so a matched chunk seeks to where its text begins.
 */
export function chunkCaptionEvents(events: ReadonlyArray<CaptionEvent>): TranscriptChunk[] {
  const chunks: TranscriptChunk[] = []
  let startMs: number | null = null
  let text = ''
  const flush = () => {
    if (startMs !== null && text) chunks.push({startSeconds: Math.floor(startMs / 1000), text})
    startMs = null
    text = ''
  }
  for (const event of events) {
    if (!event.text) continue
    if (
      startMs !== null &&
      (event.startMs - startMs >= MAX_CHUNK_SECONDS * 1000 || text.length + event.text.length + 1 > MAX_CHUNK_CHARS)
    ) {
      flush()
    }
    if (startMs === null) startMs = event.startMs
    text = text ? `${text} ${event.text}` : event.text
  }
  flush()
  return chunks
}

const CHAPTER_LINE = /^\s*[([]?(\d{1,2}):(\d{1,2})(?::(\d{2}))?[)\]]?\s*[-–—:.]?\s*(\S.*)$/

/**
 * Parses `[H:]MM:SS Label` chapter lines out of a video description.
 * Applies YouTube's own chapter rules — at least two entries, the first at
 * 0:00, strictly ascending — and returns `[]` when the lines look like
 * incidental timestamps rather than a chapter list.
 */
export function parseDescriptionChapters(
  description: string | null | undefined,
  durationSeconds?: number | null,
): Chapter[] {
  if (typeof description !== 'string' || !description) return []
  const chapters: Chapter[] = []
  for (const line of description.split('\n')) {
    const match = CHAPTER_LINE.exec(line)
    if (!match) continue
    const [, a, b, c, rawLabel] = match
    const startSeconds = c
      ? Number(a) * 3600 + Number(b) * 60 + Number(c)
      : Number(a) * 60 + Number(b)
    const label = collapseWhitespace(rawLabel)
    if (!label) continue
    chapters.push({startSeconds, label})
  }
  if (chapters.length < 2) return []
  if (chapters[0].startSeconds !== 0) return []
  for (let i = 1; i < chapters.length; i++) {
    if (chapters[i].startSeconds <= chapters[i - 1].startSeconds) return []
  }
  if (
    typeof durationSeconds === 'number' &&
    durationSeconds > 0 &&
    chapters.some((chapter) => chapter.startSeconds >= durationSeconds)
  ) {
    return []
  }
  return chapters
}

/**
 * Builds the validated `video` document for a `createOrReplace` mutation.
 * Throws when neither chapters nor transcript chunks exist — a document must
 * never imply moment search is available when ingestion produced nothing
 * usable (VIDEO_PIPELINE §11).
 */
export function buildVideoDocument(input: {
  parsed: ParsedVideo
  title?: string | null
  durationSeconds?: number | null
  chapters: ReadonlyArray<Chapter>
  transcriptChunks: ReadonlyArray<TranscriptChunk>
  ingestedAt: Date
}): VideoDocument {
  const {parsed, title, durationSeconds, chapters, transcriptChunks, ingestedAt} = input
  if (chapters.length === 0 && transcriptChunks.length === 0) {
    throw new Error('refusing to build a video document with no chapters and no transcript chunks')
  }
  return videoDocumentSchema.parse({
    _id: parsed.documentId,
    _type: 'video',
    videoId: parsed.videoId,
    provider: parsed.provider,
    providerVideoId: parsed.providerVideoId,
    sourceUrl: parsed.canonicalUrl,
    title: title?.trim() || undefined,
    durationSeconds:
      typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) && durationSeconds >= 0
        ? Math.floor(durationSeconds)
        : undefined,
    chapters: chapters.length
      ? chapters.map((chapter, i) => ({_key: `ch-${chapter.startSeconds}-${i}`, ...chapter}))
      : undefined,
    transcriptChunks: transcriptChunks.length
      ? transcriptChunks.map((chunk, i) => ({_key: `tc-${chunk.startSeconds}-${i}`, ...chunk}))
      : undefined,
    ingestedAt: ingestedAt.toISOString(),
  })
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}
