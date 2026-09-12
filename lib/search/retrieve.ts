import 'server-only'

import {z} from 'zod'

// Relative `.ts` import (like rank.ts) so `node --test` can load this module.
import {parseVideoUrl} from '../video/provider.ts'
import {MAX_MOMENTS_PER_VIDEO, MAX_VISUAL_LINES} from './queries.ts'
import type {SearchCourseContext} from './schema'

/**
 * Turns raw MCP `groq_query` rows into typed, grounded candidates
 * (SEARCH.md §3.2, §7). Parsing is lenient per row — malformed rows are
 * dropped, never repaired into fabricated data.
 */

const MAX_SNIPPET_LENGTH = 140

/**
 * Published document ids only. Draft (`drafts.`) and release-version
 * (`versions.`) rows are dropped — defence in depth in case the MCP ever
 * returns a non-published perspective (development plan §3).
 */
const publishedIdSchema = z
  .string()
  .refine((id) => !id.startsWith('drafts.') && !id.startsWith('versions.'), 'not a published document id')

/** Course row with the modules map needed to derive module/lesson positions. */
const courseRawSchema = z.object({
  _id: publishedIdSchema,
  title: z.string(),
  slug: z.string(),
  level: z.string().nullish(),
  coverImageUrl: z.string().nullish(),
  modules: z
    .array(
      z.object({
        _key: z.string(),
        title: z.string().nullish(),
        lessonIds: z.array(z.string().nullable()).nullish(),
      }),
    )
    .nullish(),
})

type CourseRaw = z.infer<typeof courseRawSchema>

const lessonRowSchema = z.object({
  _id: publishedIdSchema,
  title: z.string(),
  slug: z.string(),
  durationSeconds: z.number().int().nonnegative().nullish(),
  freePreview: z.boolean().nullish(),
  posterUrl: z.string().nullish(),
  keyPoints: z.array(z.string()).nullish(),
  proTip: z.string().nullish(),
  notesHits: z.array(z.boolean()).nullish(),
  course: courseRawSchema.nullish(),
})

const courseRowSchema = z.object({
  _id: publishedIdSchema,
  title: z.string(),
  slug: z.string(),
  level: z.string().nullish(),
  summary: z.string().nullish(),
  coverImageUrl: z.string().nullish(),
  modules: z
    .array(
      z.object({
        _key: z.string(),
        title: z.string().nullish(),
        lessons: z
          .array(
            z
              .object({
                _id: publishedIdSchema,
                title: z.string(),
                slug: z.string(),
                durationSeconds: z.number().int().nonnegative().nullish(),
                freePreview: z.boolean().nullish(),
                posterUrl: z.string().nullish(),
                keyPoints: z.array(z.string()).nullish(),
                proTip: z.string().nullish(),
              })
              .nullable(),
          )
          .nullish(),
      }),
    )
    .nullish(),
})

const momentSchema = z.object({
  startSeconds: z.number().int().nonnegative(),
})

const videoRowSchema = z.object({
  _id: publishedIdSchema,
  videoId: z.string(),
  chapterMatches: z.array(momentSchema.extend({label: z.string()})).nullish(),
  transcriptMatches: z.array(momentSchema.extend({text: z.string()})).nullish(),
})

/**
 * One `videoVisualIndex` row: matching OCR/VLM chunks with only their matching
 * lines. Validated independently of the Context allowlist: the row and the
 * video it references must be published documents of the expected types, the
 * video's id must be the one derived from its `videoId`, and any malformed or
 * over-long part rejects the whole row rather than being partially trusted.
 */
const visualRowSchema = z.object({
  _id: publishedIdSchema,
  _type: z.literal('videoVisualIndex'),
  video: z
    .object({_id: publishedIdSchema, _type: z.literal('video'), videoId: z.string().min(1)})
    .refine((video) => video._id === `video-${video.videoId}`, 'video document id does not match its videoId'),
  visualMatches: z
    .array(
      momentSchema.extend({
        source: z.enum(['ocr', 'vlm']),
        lines: z.array(z.string()).min(1).max(MAX_VISUAL_LINES),
      }),
    )
    .max(MAX_MOMENTS_PER_VIDEO),
})

const lessonVideoIndexRowSchema = z.object({
  _id: publishedIdSchema,
  _type: z.literal('lesson'),
  title: z.string(),
  slug: z.string(),
  durationSeconds: z.number().int().nonnegative().nullish(),
  freePreview: z.boolean().nullish(),
  posterUrl: z.string().nullish(),
  videoUrl: z.string().nullish(),
  course: courseRawSchema.nullish(),
})

export type LessonCandidate = {
  lessonId: string
  title: string
  slug: string
  durationSeconds: number | null
  freePreview: boolean | null
  posterUrl: string | null
  keyPoints: string[]
  proTip: string | null
  /** Per-term notes plain-text match flags (computed in GROQ, term order). */
  notesHits: boolean[]
  course: SearchCourseContext | null
  courseSummary: string | null
  /** True when the candidate came from a course-level match (broad tier). */
  broad: boolean
  /** Course title + summary, scored for broad candidates. */
  courseMatchText: string | null
}

export type VideoMomentCandidate = {
  lessonId: string
  title: string
  slug: string
  durationSeconds: number | null
  freePreview: boolean | null
  posterUrl: string | null
  course: SearchCourseContext | null
  startSeconds: number
  /** `ocr`/`vlm`: on-screen text or a labelled model interpretation from the visual index. */
  matchKind: 'chapter' | 'transcript' | 'ocr' | 'vlm'
  momentText: string
}

/** Derives the result-facing course context for one lesson (order-derived numbering). */
function toCourseContext(course: CourseRaw | null | undefined, lessonId: string): SearchCourseContext | null {
  if (!course) return null
  let moduleTitle: string | null = null
  let position: string | null = null
  const modules = course.modules ?? []
  for (let moduleIndex = 0; moduleIndex < modules.length; moduleIndex++) {
    const lessonIds = modules[moduleIndex].lessonIds ?? []
    const lessonIndex = lessonIds.indexOf(lessonId)
    if (lessonIndex >= 0) {
      moduleTitle = modules[moduleIndex].title ?? null
      position = `${moduleIndex + 1}.${lessonIndex + 1}`
      break
    }
  }
  return {
    id: course._id,
    title: course.title,
    slug: course.slug,
    level: course.level ?? null,
    coverImageUrl: course.coverImageUrl ?? null,
    moduleTitle,
    position,
  }
}

/** Retains only rows that satisfy the supplied runtime schema. */
function parseRows<T>(rows: unknown, schema: z.ZodType<T>): T[] {
  if (!Array.isArray(rows)) return []
  const parsed: T[] = []
  for (const row of rows) {
    const result = schema.safeParse(row)
    if (result.success) parsed.push(result.data)
  }
  return parsed
}

/** Converts validated lesson query rows into deterministic ranking candidates. */
export function parseLessonCandidates(rows: unknown): LessonCandidate[] {
  return parseRows(rows, lessonRowSchema).map((row) => ({
    lessonId: row._id,
    title: row.title,
    slug: row.slug,
    durationSeconds: row.durationSeconds ?? null,
    freePreview: row.freePreview ?? null,
    posterUrl: row.posterUrl ?? null,
    keyPoints: row.keyPoints ?? [],
    proTip: row.proTip ?? null,
    notesHits: row.notesHits ?? [],
    course: toCourseContext(row.course, row._id),
    courseSummary: null,
    broad: false,
    courseMatchText: null,
  }))
}

/** Lessons of matched courses become broad-tier candidates. */
export function parseCourseCandidates(rows: unknown): LessonCandidate[] {
  const candidates: LessonCandidate[] = []
  for (const course of parseRows(rows, courseRowSchema)) {
    const modules = course.modules ?? []
    modules.forEach((mod, moduleIndex) => {
      ;(mod.lessons ?? []).forEach((lesson, lessonIndex) => {
        if (!lesson) return
        candidates.push({
          lessonId: lesson._id,
          title: lesson.title,
          slug: lesson.slug,
          durationSeconds: lesson.durationSeconds ?? null,
          freePreview: lesson.freePreview ?? null,
          posterUrl: lesson.posterUrl ?? null,
          keyPoints: lesson.keyPoints ?? [],
          proTip: lesson.proTip ?? null,
          notesHits: [],
          course: {
            id: course._id,
            title: course.title,
            slug: course.slug,
            level: course.level ?? null,
            coverImageUrl: course.coverImageUrl ?? null,
            moduleTitle: mod.title ?? null,
            position: `${moduleIndex + 1}.${lessonIndex + 1}`,
          },
          courseSummary: course.summary ?? null,
          broad: true,
          courseMatchText: [course.title, course.summary ?? ''].join(' '),
        })
      })
    })
  }
  return candidates
}

/**
 * Grounds matched video moments to the lesson that uses the video: a moment
 * survives only when a lesson's `parseVideoUrl(videoUrl).videoId` equals the
 * video document's `videoId` (SEARCH.md §7). Chapter matches suppress the
 * transcript and visual fallbacks for the same video (SEARCH.md §4).
 * `visualRows` come from `buildVisualCandidatesQuery` (flag-gated).
 */
export function parseVideoMomentCandidates(
  videoRows: unknown,
  lessonIndexRows: unknown,
  visualRows: unknown = [],
): VideoMomentCandidate[] {
  const lessonsByVideoId = new Map<string, z.infer<typeof lessonVideoIndexRowSchema>>()
  for (const lesson of parseRows(lessonIndexRows, lessonVideoIndexRowSchema)) {
    const parsed = parseVideoUrl(lesson.videoUrl)
    // First (oldest-returned) lesson wins deterministically per video.
    if (parsed && !lessonsByVideoId.has(parsed.videoId)) lessonsByVideoId.set(parsed.videoId, lesson)
  }

  const candidates: VideoMomentCandidate[] = []
  const chapterMatched = new Set<string>()
  const push = (
    lesson: z.infer<typeof lessonVideoIndexRowSchema>,
    moments: Array<Pick<VideoMomentCandidate, 'startSeconds' | 'matchKind' | 'momentText'>>,
  ) => {
    for (const moment of moments) {
      candidates.push({
        lessonId: lesson._id,
        title: lesson.title,
        slug: lesson.slug,
        durationSeconds: lesson.durationSeconds ?? null,
        freePreview: lesson.freePreview ?? null,
        posterUrl: lesson.posterUrl ?? null,
        course: toCourseContext(lesson.course, lesson._id),
        ...moment,
      })
    }
  }

  for (const video of parseRows(videoRows, videoRowSchema)) {
    const lesson = lessonsByVideoId.get(video.videoId)
    if (!lesson) continue

    const chapters = video.chapterMatches ?? []
    if (chapters.length > 0) chapterMatched.add(video.videoId)
    push(
      lesson,
      chapters.length > 0
        ? chapters.map((chapter) => ({
            startSeconds: chapter.startSeconds,
            matchKind: 'chapter' as const,
            momentText: chapter.label,
          }))
        : (video.transcriptMatches ?? []).map((chunk) => ({
            startSeconds: chunk.startSeconds,
            matchKind: 'transcript' as const,
            momentText: snippet(chunk.text),
          })),
    )
  }

  for (const visual of parseRows(visualRows, visualRowSchema)) {
    const lesson = lessonsByVideoId.get(visual.video.videoId)
    if (!lesson || chapterMatched.has(visual.video.videoId)) continue
    push(
      lesson,
      visual.visualMatches
        .map((chunk) => ({
          startSeconds: chunk.startSeconds,
          matchKind: chunk.source,
          momentText: snippet(chunk.lines.map((line) => line.trim()).filter(Boolean).join(' … ')),
        }))
        .filter((moment) => moment.momentText.length > 0),
    )
  }
  return candidates
}

function snippet(text: string): string {
  return text.length > MAX_SNIPPET_LENGTH ? `${text.slice(0, MAX_SNIPPET_LENGTH).trimEnd()}…` : text
}
