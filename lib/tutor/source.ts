import {z} from 'zod'

import type {StoredChunk} from '../evidence/chunks.ts'

/**
 * Published content the tutor reads (development plan §5 PR-6), behind a
 * port so the service runs against fixtures in tests and against the
 * Sanity HTTP API in the offline evaluation. The web app's implementation
 * is `sanity-source.ts` (server-only).
 *
 * Every GROQ query is parameterized: search terms travel as `$t0…` params
 * (re-validated here) and only numeric bounds are inlined. Chunk arrays are
 * filtered and sliced inside GROQ, so a whole transcript never enters the
 * request path. Draft and release ids are excluded explicitly, on top of
 * the published perspective.
 */

export type TutorLesson = {
  id: string
  title: string
  slug: string
  durationSeconds: number | null
  videoUrl: string | null
}

/** A published lesson with the published lessons of its parent course, in curriculum order. */
export type TutorLessonContext = TutorLesson & {courseLessons: TutorLesson[]}

/** A video record: `id` is the document id chunk ids derive from. */
export type TutorVideo = {id: string; videoId: string; durationSeconds: number | null}

export type ChunkRange = {fromSeconds: number; toSeconds: number}

export type TutorSource = {
  loadLesson(lessonId: string): Promise<TutorLessonContext | null>
  /** The oldest video record per stable video id (duplicates resolve deterministically). */
  loadVideos(videoIds: readonly string[]): Promise<TutorVideo[]>
  /** Chunks of one video starting inside `range`, in time order, at most `limit`. */
  loadWindow(videoDocumentId: string, range: ChunkRange, limit: number): Promise<StoredChunk[]>
  /** Chunks that prefix-match any term, per video, outside `exclude`, at most `perVideo` each. */
  searchChunks(
    videoDocumentIds: readonly string[],
    terms: readonly string[],
    exclude: ChunkRange | null,
    perVideo: number,
  ): Promise<Array<{videoDocumentId: string; chunks: StoredChunk[]}>>
}

export const MAX_COURSE_LESSON_ROWS = 60
export const MAX_VIDEO_ROWS = 40
const MAX_CHUNK_FETCH = 32

/** Same token shape `sanitizeTerms` produces; nothing else reaches a GROQ `match`. */
const SAFE_TERM = /^[a-z0-9-]{2,32}$/
const MAX_QUERY_TERMS = 12

const PUBLISHED = /* groq */ `!(_id in path("drafts.**")) && !(_id in path("versions.**"))`

const lessonFields = /* groq */ `_id, title, "slug": slug.current, durationSeconds, videoUrl`

/** The lesson, and the lessons of the oldest published course referencing it (as on the lesson page). */
export const LESSON_CONTEXT_QUERY = /* groq */ `
  *[_type == "lesson" && _id == $lessonId && ${PUBLISHED}][0]{
    ${lessonFields},
    "courseLessons": (*[_type == "course" && references(^._id) && ${PUBLISHED}] | order(_createdAt asc)[0]
      .modules[].lessons[]->{ ${lessonFields} })[0...${MAX_COURSE_LESSON_ROWS}]
  }
`

export const VIDEOS_QUERY = /* groq */ `
  *[_type == "video" && videoId in $videoIds && ${PUBLISHED}] | order(_createdAt asc)[0...${MAX_VIDEO_ROWS}]{
    _id, videoId, durationSeconds
  }
`

export function buildWindowQuery(limit: number): string {
  return /* groq */ `
    *[_type == "video" && _id == $videoDocumentId && ${PUBLISHED}][0]{
      "chunks": transcriptChunks[startSeconds >= $fromSeconds && startSeconds <= $toSeconds]
        | order(startSeconds asc)[0...${boundedCount(limit)}]{ _key, startSeconds, text }
    }
  `
}

/** OR-matched terms as params (`text match $t0 || …`); GROQ `match` against an array would AND them. */
export function buildChunkSearchQuery(termCount: number, perVideo: number): string {
  if (!Number.isInteger(termCount) || termCount < 1 || termCount > MAX_QUERY_TERMS) {
    throw new Error(`term count out of range: ${termCount}`)
  }
  const matches = Array.from({length: termCount}, (_, i) => `text match $t${i}`).join(' || ')
  return /* groq */ `
    *[_type == "video" && _id in $videoDocumentIds && ${PUBLISHED}][0...${MAX_VIDEO_ROWS}]{
      _id,
      "chunks": transcriptChunks[(${matches}) && !(startSeconds >= $excludeFrom && startSeconds <= $excludeTo)]
        | order(startSeconds asc)[0...${boundedCount(perVideo)}]{ _key, startSeconds, text }
    }
  `
}

/** Params for `buildChunkSearchQuery`: each term re-validated, then prefix-wildcarded. */
export function chunkSearchParams(
  videoDocumentIds: readonly string[],
  terms: readonly string[],
  exclude: ChunkRange | null,
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    videoDocumentIds: [...videoDocumentIds],
    excludeFrom: exclude?.fromSeconds ?? -1,
    excludeTo: exclude?.toSeconds ?? -1,
  }
  terms.forEach((term, i) => {
    if (!SAFE_TERM.test(term)) throw new Error(`unsafe search term: ${JSON.stringify(term)}`)
    params[`t${i}`] = `${term}*`
  })
  return params
}

function boundedCount(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_CHUNK_FETCH) throw new Error(`chunk limit out of range: ${value}`)
  return value
}

const publishedId = z.string().refine((id) => !id.startsWith('drafts.') && !id.startsWith('versions.'))
const seconds = z.number().int().nonnegative()

const lessonRowSchema = z.object({
  _id: publishedId,
  title: z.string().min(1),
  slug: z.string().min(1),
  durationSeconds: seconds.nullish(),
  videoUrl: z.string().nullish(),
})

const chunkRowSchema = z.object({_key: z.string().min(1), startSeconds: seconds, text: z.string()})
const videoRowSchema = z.object({_id: publishedId, videoId: z.string().min(1), durationSeconds: z.number().nonnegative().nullish()})

const toLesson = (row: z.infer<typeof lessonRowSchema>): TutorLesson => ({
  id: row._id,
  title: row.title,
  slug: row.slug,
  durationSeconds: row.durationSeconds ?? null,
  videoUrl: row.videoUrl ?? null,
})

/** Keeps the rows that parse; a malformed row is dropped, never repaired. */
function parseRows<T>(rows: unknown, schema: z.ZodType<T>): T[] {
  if (!Array.isArray(rows)) return []
  return rows.flatMap((row) => {
    const parsed = schema.safeParse(row)
    return parsed.success ? [parsed.data] : []
  })
}

/** A `TutorSource` over any published-perspective GROQ executor. */
export function createGroqTutorSource(groq: (query: string, params: Record<string, unknown>) => Promise<unknown>): TutorSource {
  return {
    async loadLesson(lessonId) {
      const row = (await groq(LESSON_CONTEXT_QUERY, {lessonId})) as {courseLessons?: unknown} | null
      const lesson = lessonRowSchema.safeParse(row)
      if (!lesson.success) return null
      return {...toLesson(lesson.data), courseLessons: parseRows(row?.courseLessons, lessonRowSchema).map(toLesson)}
    },

    async loadVideos(videoIds) {
      if (videoIds.length === 0) return []
      const rows = parseRows(await groq(VIDEOS_QUERY, {videoIds: [...videoIds]}), videoRowSchema)
      const byVideoId = new Map<string, TutorVideo>()
      for (const row of rows) {
        if (byVideoId.has(row.videoId)) continue
        byVideoId.set(row.videoId, {id: row._id, videoId: row.videoId, durationSeconds: row.durationSeconds ?? null})
      }
      return [...byVideoId.values()]
    },

    async loadWindow(videoDocumentId, range, limit) {
      const row = (await groq(buildWindowQuery(limit), {videoDocumentId, ...range})) as {chunks?: unknown} | null
      return parseRows(row?.chunks, chunkRowSchema)
    },

    async searchChunks(videoDocumentIds, terms, exclude, perVideo) {
      if (videoDocumentIds.length === 0 || terms.length === 0) return []
      const rows = await groq(
        buildChunkSearchQuery(terms.length, perVideo),
        chunkSearchParams(videoDocumentIds, terms, exclude),
      )
      return parseRows(rows, z.object({_id: publishedId, chunks: z.unknown()})).map((row) => ({
        videoDocumentId: row._id,
        chunks: parseRows(row.chunks, chunkRowSchema),
      }))
    },
  }
}
