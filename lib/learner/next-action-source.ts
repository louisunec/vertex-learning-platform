import {z} from 'zod'

import type {CheckCandidate} from '../assessments/learner.ts'
import type {GraphEdge} from '../concepts/graph.ts'
import type {ProgressRow} from '../course-progress.ts'
import type {LearnerContentSource} from './content-source.ts'

/**
 * Content and learner-state reads the next-action service needs beyond the
 * learner-evidence content source (PR-11). The Sanity implementation is
 * `next-action-content.ts` (server-only); tests pass fixtures. Every method
 * returns only published, parsed data and throws `ContentUnavailableError`
 * when a read fails, so a failure is never mistaken for "nothing to do".
 */

export type GoalCourseLesson = {_id: string; title: string; slug: string; durationSeconds: number | null}

export type GoalCourse = {
  _id: string
  title: string
  slug: string
  summary: string | null
  /** Published lessons in module order; unpublished references are already dropped. */
  lessons: GoalCourseLesson[]
}

export type PlanConceptSource = {chunkId: string | null; lessonId: string; startSeconds: number; endSeconds: number | null}

export type PlanConcept = {id: string; conceptId: string; name: string; sources: PlanConceptSource[]}

export type CourseOption = {_id: string; title: string; slug: string}

export type NextActionContentSource = Pick<LearnerContentSource, 'loadConceptIndex' | 'loadReviewCandidates'> & {
  /** Published courses a learner may choose as a goal. */
  loadGoalCourses(): Promise<CourseOption[]>
  /** The published course, or null when it doesn't exist or isn't published. */
  loadCourse(courseId: string): Promise<GoalCourse | null>
  /** The learner's `progress` rows (Sanity learner state), keyed by the server-resolved Clerk id. */
  loadProgress(learnerId: string): Promise<ProgressRow[]>
  /** Servable concepts taught in `lessonIds`, with their cited chunks there. */
  loadCourseConcepts(lessonIds: string[]): Promise<PlanConcept[]>
  /** Approved, current prerequisite edges whose dependent is one of `conceptIds` (document ids). */
  loadPrerequisiteEdges(conceptIds: string[]): Promise<GraphEdge[]>
  /** Items the lesson checks of `lessonIds` may issue now (PR-7 rules). */
  loadCourseCheckCandidates(lessonIds: string[]): Promise<CheckCandidate[]>
}

/* ---------- Row parsers (framework-free, so they are unit-tested) ---------- */

/** Keeps the rows that parse; a malformed row is left out, never guessed. */
function parseRows<T>(schema: z.ZodType<T>, rows: unknown): T[] {
  if (!Array.isArray(rows)) return []
  return rows.flatMap((row) => {
    const parsed = schema.safeParse(row)
    return parsed.success ? [parsed.data] : []
  })
}

const text = z.string().trim().min(1)
const seconds = z.number().finite().nonnegative()

const courseOptionSchema = z.object({_id: text, title: text, slug: text})

const lessonRowSchema = z.object({_id: text, title: text, slug: text, durationSeconds: seconds.nullish()})

const courseSchema = z.object({
  _id: text,
  title: text,
  slug: text,
  summary: z.string().nullish(),
  modules: z.array(z.object({lessons: z.array(z.unknown()).nullish()}).nullable().catch(null)).nullish(),
})

const conceptSchema = z.object({
  id: text,
  conceptId: text,
  name: text,
  sources: z.array(z.unknown()).nullish(),
})

const sourceSchema = z.object({chunkId: z.string().nullish(), lessonId: text, startSeconds: seconds, endSeconds: seconds.nullish()})

const edgeSchema = z.object({id: text, prerequisite: z.string().nullable(), dependent: z.string().nullable(), status: text})

const progressSchema = z.object({
  lessonId: text,
  completed: z.boolean().nullish(),
  resumeSeconds: seconds.nullish(),
  updatedAt: z.string().nullish(),
})

export function toCourseOptions(rows: unknown): CourseOption[] {
  return parseRows(courseOptionSchema, rows)
}

/** The course with its published lessons flattened in module order, each once; null when the row doesn't parse. */
export function toGoalCourse(row: unknown): GoalCourse | null {
  const parsed = courseSchema.safeParse(row)
  if (!parsed.success) return null
  const {modules, summary, ...course} = parsed.data
  const lessons = new Map<string, GoalCourseLesson>()
  for (const lesson of parseRows(lessonRowSchema, (modules ?? []).flatMap((module) => module?.lessons ?? []))) {
    if (!lessons.has(lesson._id)) lessons.set(lesson._id, {...lesson, durationSeconds: lesson.durationSeconds ?? null})
  }
  return {...course, summary: summary?.trim() || null, lessons: [...lessons.values()]}
}

export function toPlanConcepts(rows: unknown): PlanConcept[] {
  return parseRows(conceptSchema, rows).map((concept) => ({
    id: concept.id,
    conceptId: concept.conceptId,
    name: concept.name,
    sources: parseRows(sourceSchema, concept.sources ?? []).map((source) => ({
      chunkId: source.chunkId ?? null,
      lessonId: source.lessonId,
      startSeconds: source.startSeconds,
      endSeconds: source.endSeconds ?? null,
    })),
  }))
}

export function toPrerequisiteEdges(rows: unknown): GraphEdge[] {
  return parseRows(edgeSchema, rows)
}

export function toProgressRows(rows: unknown): ProgressRow[] {
  return parseRows(progressSchema, rows).map((row) => ({
    lessonId: row.lessonId,
    completed: row.completed ?? null,
    resumeSeconds: row.resumeSeconds ?? null,
    updatedAt: row.updatedAt ?? null,
  }))
}
