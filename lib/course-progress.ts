import {flattenLessons} from '../sanity/lib/curriculum.ts'

/**
 * Per-learner course progress derived from stored `progress` rows and the
 * course's ordered modules. Pure and deterministic: nothing here is persisted.
 */

type LessonLike = {_id: string} | null
type ModuleLike = {_key: string; title?: string | null; lessons?: ReadonlyArray<LessonLike> | null}

export type ProgressRow = {
  lessonId: string
  completed: boolean | null
  resumeSeconds: number | null
  updatedAt: string | null
}

export type CourseProgress = {
  /** Lessons in this course that resolve to a document. */
  totalLessons: number
  completedLessons: number
  /** 0–100, integer. */
  percent: number
  /** Whether the learner has any stored state for a lesson in this course. */
  hasProgress: boolean
  /** Ids of completed lessons in this course. */
  completedIds: ReadonlySet<string>
  /**
   * Where "Continue Learning" should go: the most recently touched incomplete
   * lesson, else the first incomplete lesson, else the first lesson.
   */
  resumeLessonId: string | null
}

export function summarizeCourseProgress(
  modules: ReadonlyArray<ModuleLike> | null | undefined,
  rows: ReadonlyArray<ProgressRow> | null | undefined,
): CourseProgress {
  const ordered = flattenLessons(modules).map((entry) => entry.lesson._id)
  const inCourse = new Set(ordered)

  const relevant = (rows ?? []).filter((row) => inCourse.has(row.lessonId))
  const completedIds = new Set(relevant.filter((row) => row.completed).map((row) => row.lessonId))

  const touchedIncomplete = relevant
    .filter((row) => !row.completed)
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))

  const resumeLessonId =
    touchedIncomplete[0]?.lessonId ??
    ordered.find((id) => !completedIds.has(id)) ??
    ordered[0] ??
    null

  const totalLessons = ordered.length
  const completedLessons = completedIds.size

  return {
    totalLessons,
    completedLessons,
    percent: totalLessons === 0 ? 0 : Math.round((completedLessons / totalLessons) * 100),
    hasProgress: relevant.length > 0,
    completedIds,
    resumeLessonId,
  }
}
