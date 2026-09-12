import {z} from 'zod'

/**
 * Canonical search contract (SEARCH.md §2, §3.4). Every structured search
 * response crossing the server/client boundary must pass these schemas.
 * Nothing model-generated reaches the client unvalidated.
 */

/** Course/module context a result card needs. Derived, never fabricated. */
export const searchCourseContextSchema = z.object({
  id: z.string(),
  title: z.string(),
  slug: z.string(),
  level: z.string().nullable(),
  /** Course cover asset URL used as the result row's course icon. */
  coverImageUrl: z.string().nullable(),
  moduleTitle: z.string().nullable(),
  /** Derived "module.lesson" position, e.g. "2.3"; null when not referenced. */
  position: z.string().nullable(),
})

const lessonBaseShape = {
  lessonId: z.string(),
  title: z.string(),
  slug: z.string(),
  /** Navigation target (video results include `?t=<seconds>`). */
  href: z.string(),
  /** Concise grounded description from stored fields only. */
  description: z.string(),
  durationSeconds: z.number().int().nonnegative().nullable(),
  freePreview: z.boolean().nullable(),
  posterUrl: z.string().nullable(),
  course: searchCourseContextSchema.nullable(),
}

export const lessonSearchResultSchema = z.object({
  type: z.literal('lesson'),
  ...lessonBaseShape,
  keyPoints: z.array(z.string()).max(4),
})

export const videoSearchResultSchema = z.object({
  type: z.literal('video'),
  ...lessonBaseShape,
  /** Real matched timestamp within the lesson's video. */
  startSeconds: z.number().int().nonnegative(),
  /**
   * Chapter matches outrank transcript fallbacks (SEARCH.md §4); `ocr` is
   * on-screen text and `vlm` a labelled model interpretation of the frame.
   */
  matchKind: z.enum(['chapter', 'transcript', 'ocr', 'vlm']),
  /** Matched chapter label, or a short transcript or on-screen snippet. */
  momentLabel: z.string(),
})

export const searchResultSchema = z.discriminatedUnion('type', [
  lessonSearchResultSchema,
  videoSearchResultSchema,
])

export const searchResponseSchema = z.object({
  query: z.string(),
  results: z.array(searchResultSchema),
  /** Grounded count of the full ranked, deduplicated result set. */
  total: z.number().int().nonnegative(),
  /** Distinct courses represented in that full ranked set. */
  courseCount: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
})

export type SearchCourseContext = z.infer<typeof searchCourseContextSchema>
export type LessonSearchResult = z.infer<typeof lessonSearchResultSchema>
export type VideoSearchResult = z.infer<typeof videoSearchResultSchema>
export type SearchResult = z.infer<typeof searchResultSchema>
export type SearchResponse = z.infer<typeof searchResponseSchema>

/**
 * Pagination cursor: the interpreted terms plus the next offset, so follow-up
 * pages reuse the interpretation instead of re-calling the LLM. Terms are
 * re-validated with the same bounds as freshly sanitized ones — the cursor
 * only parameterizes grounded retrieval.
 */
export const MAX_CURSOR_OFFSET = 500

export const searchCursorSchema = z.object({
  v: z.literal(1),
  terms: z
    .array(z.string().regex(/^[a-z0-9-]{2,32}$/))
    .min(1)
    .max(12),
  offset: z.number().int().nonnegative().max(MAX_CURSOR_OFFSET),
})

export type SearchCursor = z.infer<typeof searchCursorSchema>

/** Encodes validated search state into an opaque URL-safe cursor. */
export function encodeSearchCursor(cursor: SearchCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

/** Decodes and validates an opaque cursor, returning `null` for invalid input. */
export function decodeSearchCursor(raw: string | null | undefined): SearchCursor | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    return searchCursorSchema.parse(parsed)
  } catch {
    return null
  }
}
