/**
 * Deterministic curriculum derivations. Module and lesson numbers are never
 * stored in Sanity; they come from array order (DATA_MODEL §10).
 */

type LessonLike = {_id: string} | null
type ModuleLike = {
  _key: string
  title?: string | null
  lessons?: ReadonlyArray<LessonLike> | null
}

export type LessonContext<M extends ModuleLike = ModuleLike> = {
  module: M
  /** Zero-based */
  moduleIndex: number
  /** One-based, for display ("Module 5") */
  moduleNumber: number
  /** Zero-based */
  lessonIndex: number
  /** One-based, for display ("Lesson 5.1") */
  lessonNumber: number
  /** e.g. "5.1" */
  position: string
}

export function moduleLabel(moduleNumber: number): string {
  return `Module ${moduleNumber}`
}

export function lessonLabel(moduleNumber: number, lessonNumber: number): string {
  return `Lesson ${moduleNumber}.${lessonNumber}`
}

/** Finds where a lesson sits in a course's ordered modules, or `null` if it is not referenced. */
export function findLessonContext<M extends ModuleLike>(
  modules: ReadonlyArray<M> | null | undefined,
  lessonId: string,
): LessonContext<M> | null {
  if (!modules) return null
  for (let moduleIndex = 0; moduleIndex < modules.length; moduleIndex++) {
    const mod = modules[moduleIndex]
    const lessons = mod.lessons ?? []
    for (let lessonIndex = 0; lessonIndex < lessons.length; lessonIndex++) {
      if (lessons[lessonIndex]?._id === lessonId) {
        return {
          module: mod,
          moduleIndex,
          moduleNumber: moduleIndex + 1,
          lessonIndex,
          lessonNumber: lessonIndex + 1,
          position: `${moduleIndex + 1}.${lessonIndex + 1}`,
        }
      }
    }
  }
  return null
}

/** Total number of resolvable lessons across modules (missing/deleted references are skipped). */
export function countLessons(modules: ReadonlyArray<ModuleLike> | null | undefined): number {
  if (!modules) return 0
  return modules.reduce((total, mod) => total + (mod.lessons ?? []).filter(Boolean).length, 0)
}

/** Ordered, numbered flat list of lessons — useful for prev/next navigation. */
export function flattenLessons<M extends ModuleLike>(
  modules: ReadonlyArray<M> | null | undefined,
): Array<LessonContext<M> & {lesson: NonNullable<M['lessons']>[number] & {_id: string}}> {
  const result: Array<LessonContext<M> & {lesson: NonNullable<M['lessons']>[number] & {_id: string}}> = []
  if (!modules) return result
  modules.forEach((mod, moduleIndex) => {
    ;(mod.lessons ?? []).forEach((lesson, lessonIndex) => {
      if (!lesson) return
      result.push({
        lesson: lesson as NonNullable<M['lessons']>[number] & {_id: string},
        module: mod,
        moduleIndex,
        moduleNumber: moduleIndex + 1,
        lessonIndex,
        lessonNumber: lessonIndex + 1,
        position: `${moduleIndex + 1}.${lessonIndex + 1}`,
      })
    })
  })
  return result
}
