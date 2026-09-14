import {conceptDocumentId} from './concepts/cluster.ts'
import {resolveConcept, type ConceptNode} from './concepts/resolve.ts'
import {summarizeCourseProgress, type CourseProgress, type ProgressRow} from './course-progress.ts'
import type {EvidenceReason} from './learner/evidence.ts'

/**
 * View model for the My Learning overview. Pure and deterministic: every
 * value is derived from the learner's stored progress rows, graded attempts,
 * and published content. Missing data yields `null` or an empty list, never
 * a placeholder, and a failed read is reported as an error state, never as
 * "no activity".
 */

export const RECENT_LEARNING_LIMIT = 3

export type LessonRef = {_id: string; title: string; slug: string}

type CourseLike = {
  _id: string
  modules?: ReadonlyArray<{_key: string; lessons?: ReadonlyArray<LessonRef | null> | null}> | null
}

export type ActiveCourse<C extends CourseLike> = {course: C; progress: CourseProgress; lastActivityAt: string}

/** The course holding the learner's most recent progress row, or null without any. */
export function pickActiveCourse<C extends CourseLike>(
  courses: ReadonlyArray<C>,
  rows: ReadonlyArray<ProgressRow>,
): ActiveCourse<C> | null {
  let best: ActiveCourse<C> | null = null
  for (const course of courses) {
    const progress = summarizeCourseProgress(course.modules, rows)
    if (!progress.hasProgress) continue
    const lessonIds = new Set(courseLessons(course).map((lesson) => lesson._id))
    const lastActivityAt = rows
      .filter((row) => lessonIds.has(row.lessonId) && row.updatedAt)
      .reduce((latest, row) => (row.updatedAt! > latest ? row.updatedAt! : latest), '')
    if (!best || lastActivityAt > best.lastActivityAt) best = {course, progress, lastActivityAt}
  }
  return best
}

export type ContinueLesson = {lesson: LessonRef; resumeSeconds: number | null}

/**
 * Where "Continue learning" goes: the active course's resume lesson (most
 * recently touched incomplete lesson, else the first incomplete one). Null
 * once every lesson in the course is complete.
 */
export function pickContinueLesson<C extends CourseLike>(
  active: ActiveCourse<C> | null,
  rows: ReadonlyArray<ProgressRow>,
): ContinueLesson | null {
  if (!active?.progress.resumeLessonId) return null
  const lessonId = active.progress.resumeLessonId
  if (active.progress.completedIds.has(lessonId)) return null
  const lesson = courseLessons(active.course).find((entry) => entry._id === lessonId)
  if (!lesson) return null
  const seconds = rows.find((row) => row.lessonId === lessonId)?.resumeSeconds ?? null
  return {lesson, resumeSeconds: seconds && seconds > 0 ? seconds : null}
}

/**
 * Where "Continue learning" goes once the active course is finished: the
 * most recently touched incomplete lesson in the learner's other courses
 * (else such a course's first incomplete lesson), so finishing one course
 * never hides unfinished work in another. Null when every course is done.
 */
export function pickContinueElsewhere<C extends CourseLike>(
  courses: ReadonlyArray<C>,
  rows: ReadonlyArray<ProgressRow>,
  active: ActiveCourse<C>,
): {course: C; next: ContinueLesson} | null {
  let best: {course: C; next: ContinueLesson; touchedAt: string} | null = null
  for (const course of courses) {
    if (course._id === active.course._id) continue
    const progress = summarizeCourseProgress(course.modules, rows)
    if (!progress.hasProgress) continue
    const next = pickContinueLesson({course, progress, lastActivityAt: ''}, rows)
    if (!next) continue
    const touchedAt = rows.find((row) => row.lessonId === next.lesson._id)?.updatedAt ?? ''
    if (!best || touchedAt > best.touchedAt) best = {course, next, touchedAt}
  }
  return best && {course: best.course, next: best.next}
}

export type ConceptEvidence = {withEvidence: number; total: number}

/**
 * Of the servable concepts taught in a course, how many the learner has
 * independent evidence for. Evidence ids recorded at grading time are
 * re-resolved through merges; a split or unavailable concept counts for
 * nothing. Null when the course has no servable concepts.
 */
export function countConceptsWithEvidence(
  courseConceptIds: ReadonlyArray<string>,
  independentConceptIds: ReadonlyArray<string>,
  index: ReadonlyMap<string, ConceptNode>,
): ConceptEvidence | null {
  const inCourse = new Set(courseConceptIds)
  if (inCourse.size === 0) return null
  const evidenced = new Set<string>()
  for (const conceptId of independentConceptIds) {
    const resolved = resolveConcept(conceptDocumentId(conceptId), index)
    if (resolved.status === 'active' && inCourse.has(resolved.conceptId)) evidenced.add(resolved.conceptId)
  }
  return {withEvidence: evidenced.size, total: inCourse.size}
}

export type RecentAttemptRow = {lessonId: string; evidenceReason: EvidenceReason; createdAt: Date | string}

export type RecentLearningKind =
  | 'independent_practice'
  | 'hinted_practice'
  | 'solution_practice'
  | 'repeat_practice'
  | 'lesson_completed'
  | 'lesson_watched'

export type RecentLearningItem = {
  key: string
  kind: RecentLearningKind
  label: string
  lesson: LessonRef
  /** ISO timestamp. */
  at: string
}

const PRACTICE: Record<EvidenceReason, {kind: RecentLearningKind; label: string}> = {
  first_independent_response: {kind: 'independent_practice', label: 'Independent practice'},
  hint_used: {kind: 'hinted_practice', label: 'Practised with hints'},
  answer_exposed: {kind: 'solution_practice', label: 'Practised with solution shown'},
  repeat_task: {kind: 'repeat_practice', label: 'Repeated practice'},
}

/** Lesson ids the recent-learning feed may show, so their titles can be read in one query. */
export function recentLessonIds(
  rows: ReadonlyArray<ProgressRow>,
  attempts: ReadonlyArray<RecentAttemptRow>,
  limit = RECENT_LEARNING_LIMIT,
): string[] {
  const fromRows = latestRows(rows, limit).map((row) => row.lessonId)
  return [...new Set([...fromRows, ...attempts.map((attempt) => attempt.lessonId)])]
}

/** Newest-first merge of graded attempts and progress rows whose lessons still resolve. */
export function buildRecentLearning(
  rows: ReadonlyArray<ProgressRow>,
  attempts: ReadonlyArray<RecentAttemptRow>,
  lessons: ReadonlyMap<string, LessonRef>,
  limit = RECENT_LEARNING_LIMIT,
): RecentLearningItem[] {
  const items: RecentLearningItem[] = []
  attempts.forEach((attempt, i) => {
    const lesson = lessons.get(attempt.lessonId)
    const practice = PRACTICE[attempt.evidenceReason]
    const time = new Date(attempt.createdAt).getTime()
    // An unparseable or infinite timestamp (e.g. Postgres `infinity`) would make `toISOString` throw.
    if (!lesson || !practice || !Number.isFinite(time)) return
    items.push({key: `attempt-${i}`, ...practice, lesson, at: new Date(time).toISOString()})
  })
  for (const row of latestRows(rows, limit)) {
    const lesson = lessons.get(row.lessonId)
    if (!lesson) continue
    items.push({
      key: `progress-${row.lessonId}`,
      kind: row.completed ? 'lesson_completed' : 'lesson_watched',
      label: row.completed ? 'Completed lesson' : 'Watched lesson',
      lesson,
      at: new Date(row.updatedAt!).toISOString(),
    })
  }
  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit)
}

function latestRows(rows: ReadonlyArray<ProgressRow>, limit: number): ProgressRow[] {
  return rows
    .filter((row) => row.updatedAt && !Number.isNaN(Date.parse(row.updatedAt)))
    .sort((a, b) => b.updatedAt!.localeCompare(a.updatedAt!))
    .slice(0, limit)
}

function courseLessons(course: CourseLike): LessonRef[] {
  return (course.modules ?? []).flatMap((module) => (module.lessons ?? []).filter((lesson) => lesson !== null))
}

/** A settled read: the value, or the fact that the read failed. */
export type Loaded<T> = {ok: true; value: T} | {ok: false}

/** Learner evidence (PR-4) as the page could read it. */
export type EvidenceState =
  | {status: 'flag_disabled'}
  | {status: 'not_configured'}
  | {status: 'error'}
  | {status: 'ready'; recentAttempts: RecentAttemptRow[]; independentConceptIds: string[]}

export type NextStep<C> =
  | {kind: 'continue'; course: C; lesson: LessonRef; resumeSeconds: number | null}
  | {kind: 'start'}
  | {kind: 'course_complete'; course: C}
  | {kind: 'missing_content'}
  | {kind: 'error'}

export type MyCoursesState<C> =
  | {status: 'ready'; course: C; completedLessons: number; totalLessons: number}
  | {status: 'no_activity'}
  | {status: 'missing_content'}
  | {status: 'error'}

export type RecentLearningState =
  | {status: 'ready'; items: RecentLearningItem[]; partial: boolean}
  | {status: 'no_activity'}
  | {status: 'missing_content'}
  | {status: 'error'}

export type ConceptStatState = {status: 'ready'; value: ConceptEvidence} | {status: 'hidden'} | {status: 'error'}

type CourseWithTitle = CourseLike & {title: string}

export type OverviewState<C extends CourseWithTitle> = {
  nextStep: NextStep<C>
  myCourses: MyCoursesState<C>
  recent: RecentLearningState
  /** The course the concept stat is computed for, when there is one. */
  active: ActiveCourse<C> | null
}

/**
 * Card states for one learner. `courses` only matters when there is
 * progress, and `feedLessons` only when there is activity to title.
 */
export function buildOverviewState<C extends CourseWithTitle>({
  progress,
  courses,
  feedLessons,
  evidence,
}: {
  progress: Loaded<ReadonlyArray<ProgressRow>>
  courses: Loaded<ReadonlyArray<C>>
  feedLessons: Loaded<ReadonlyArray<LessonRef>>
  evidence: EvidenceState
}): OverviewState<C> {
  const rows = progress.ok ? progress.value : []
  const active = courses.ok ? pickActiveCourse(courses.value, rows) : null

  let nextStep: NextStep<C>
  let myCourses: MyCoursesState<C>
  if (!progress.ok || (rows.length > 0 && !courses.ok)) {
    nextStep = {kind: 'error'}
    myCourses = {status: 'error'}
  } else if (rows.length === 0) {
    nextStep = {kind: 'start'}
    myCourses = {status: 'no_activity'}
  } else if (!active) {
    nextStep = {kind: 'missing_content'}
    myCourses = {status: 'missing_content'}
  } else {
    const here = pickContinueLesson(active, rows)
    const next = here ? {course: active.course, next: here} : pickContinueElsewhere(courses.ok ? courses.value : [], rows, active)
    nextStep = next
      ? {kind: 'continue', course: next.course, lesson: next.next.lesson, resumeSeconds: next.next.resumeSeconds}
      : {kind: 'course_complete', course: active.course}
    myCourses = {
      status: 'ready',
      course: active.course,
      completedLessons: active.progress.completedLessons,
      totalLessons: active.progress.totalLessons,
    }
  }

  const attempts = evidence.status === 'ready' ? evidence.recentAttempts : []
  const evidenceFailed = evidence.status === 'error' || evidence.status === 'not_configured'
  const hasActivity = rows.length > 0 || attempts.length > 0
  let recent: RecentLearningState
  if (hasActivity && !feedLessons.ok) {
    recent = {status: 'error'}
  } else {
    const lessons = new Map((feedLessons.ok ? feedLessons.value : []).map((lesson) => [lesson._id, lesson]))
    const items = buildRecentLearning(rows, attempts, lessons)
    const failed = !progress.ok || evidenceFailed
    if (items.length > 0) recent = {status: 'ready', items, partial: failed}
    else if (failed) recent = {status: 'error'}
    else recent = hasActivity ? {status: 'missing_content'} : {status: 'no_activity'}
  }

  return {nextStep, myCourses, recent, active}
}

/**
 * The concept stat is shown only with evidence enabled and servable concepts
 * in the course; an evidence or concept read failure is shown as an error.
 */
export function conceptStatState(evidence: EvidenceState, concepts: Loaded<ConceptEvidence | null> | null): ConceptStatState {
  if (evidence.status === 'flag_disabled') return {status: 'hidden'}
  if (evidence.status !== 'ready') return {status: 'error'}
  if (!concepts) return {status: 'hidden'}
  if (!concepts.ok) return {status: 'error'}
  return concepts.value ? {status: 'ready', value: concepts.value} : {status: 'hidden'}
}
