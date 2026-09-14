import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import type {ConceptNode} from './concepts/resolve.ts'
import type {ProgressRow} from './course-progress.ts'
import {
  buildOverviewState,
  buildRecentLearning,
  conceptStatState,
  countConceptsWithEvidence,
  type EvidenceState,
  pickActiveCourse,
  pickContinueLesson,
  recentLessonIds,
  type LessonRef,
  type RecentAttemptRow,
} from './my-learning.ts'

const lesson = (id: string): LessonRef => ({_id: id, title: `Lesson ${id}`, slug: `lesson-${id}`})

const ml = {_id: 'course-ml', modules: [{_key: 'm1', lessons: [lesson('a'), lesson('b')]}, {_key: 'm2', lessons: [lesson('c')]}]}
const web = {_id: 'course-web', modules: [{_key: 'm1', lessons: [lesson('x'), lesson('y')]}]}

const row = (lessonId: string, updatedAt: string, extra: Partial<ProgressRow> = {}): ProgressRow => ({
  lessonId,
  completed: false,
  resumeSeconds: null,
  updatedAt,
  ...extra,
})

describe('pickActiveCourse', () => {
  it('returns null without progress', () => {
    assert.equal(pickActiveCourse([ml, web], []), null)
  })

  it('picks the course with the most recent progress row', () => {
    const rows = [row('a', '2026-09-10T00:00:00Z'), row('x', '2026-09-12T00:00:00Z')]
    const active = pickActiveCourse([ml, web], rows)
    assert.equal(active?.course._id, 'course-web')
    assert.equal(active?.progress.totalLessons, 2)
  })
})

describe('pickContinueLesson', () => {
  it('resumes the touched incomplete lesson with its stored position', () => {
    const rows = [row('a', '2026-09-10T00:00:00Z', {completed: true}), row('b', '2026-09-11T00:00:00Z', {resumeSeconds: 522})]
    const next = pickContinueLesson(pickActiveCourse([ml], rows), rows)
    assert.deepEqual(next, {lesson: lesson('b'), resumeSeconds: 522})
  })

  it('moves to the first incomplete lesson after finishing one, without a position', () => {
    const rows = [row('a', '2026-09-10T00:00:00Z', {completed: true, resumeSeconds: 300})]
    assert.deepEqual(pickContinueLesson(pickActiveCourse([ml], rows), rows), {lesson: lesson('b'), resumeSeconds: null})
  })

  it('returns null once the course is complete', () => {
    const rows = ['a', 'b', 'c'].map((id) => row(id, '2026-09-10T00:00:00Z', {completed: true}))
    assert.equal(pickContinueLesson(pickActiveCourse([ml], rows), rows), null)
  })
})

describe('countConceptsWithEvidence', () => {
  const node = (conceptId: string, reviewStatus: string, extra: Partial<ConceptNode> = {}): ConceptNode => ({
    id: `concept-${conceptId}`,
    conceptId,
    reviewStatus,
    ...extra,
  })
  const index = new Map(
    [
      node('cpt-loss', 'approved'),
      node('cpt-grad', 'approved'),
      node('cpt-old', 'merged', {mergedInto: 'concept-cpt-grad'}),
      node('cpt-split', 'split', {splitInto: ['concept-cpt-loss', 'concept-cpt-grad']}),
      node('cpt-other', 'approved'),
    ].map((n) => [n.id, n]),
  )

  it('returns null when the course has no servable concepts', () => {
    assert.equal(countConceptsWithEvidence([], ['cpt-loss'], index), null)
  })

  it('counts evidenced concepts in the course, following merges once each', () => {
    const result = countConceptsWithEvidence(['cpt-loss', 'cpt-grad', 'cpt-new'], ['cpt-old', 'cpt-grad', 'cpt-other'], index)
    assert.deepEqual(result, {withEvidence: 1, total: 3})
  })

  it('never counts a split or unknown concept', () => {
    const result = countConceptsWithEvidence(['cpt-loss', 'cpt-grad'], ['cpt-split', 'cpt-missing'], index)
    assert.deepEqual(result, {withEvidence: 0, total: 2})
  })
})

describe('recent learning', () => {
  const lessons = new Map(['a', 'b', 'c'].map((id) => [id, lesson(id)]))
  const attempts: RecentAttemptRow[] = [
    {lessonId: 'a', evidenceReason: 'first_independent_response', createdAt: new Date('2026-09-13T10:00:00Z')},
    {lessonId: 'b', evidenceReason: 'hint_used', createdAt: '2026-09-12T10:00:00Z'},
    {lessonId: 'gone', evidenceReason: 'answer_exposed', createdAt: '2026-09-13T11:00:00Z'},
  ]
  const rows = [
    row('c', '2026-09-11T10:00:00Z'),
    row('b', '2026-09-13T09:00:00Z', {completed: true}),
    row('a', '2026-09-01T00:00:00Z', {updatedAt: null}),
  ]

  it('collects the lesson ids to resolve in one read', () => {
    assert.deepEqual(recentLessonIds(rows, attempts), ['b', 'c', 'a', 'gone'])
  })

  it('merges attempts and progress newest first, dropping unresolved lessons, bounded to three', () => {
    const items = buildRecentLearning(rows, attempts, lessons)
    assert.deepEqual(
      items.map((item) => [item.label, item.lesson._id, item.at]),
      [
        ['Independent practice', 'a', '2026-09-13T10:00:00.000Z'],
        ['Completed lesson', 'b', '2026-09-13T09:00:00.000Z'],
        ['Practised with hints', 'b', '2026-09-12T10:00:00.000Z'],
      ],
    )
  })

  it('labels watched lessons and every evidence reason', () => {
    const all: RecentAttemptRow[] = [
      {lessonId: 'a', evidenceReason: 'answer_exposed', createdAt: '2026-09-13T03:00:00Z'},
      {lessonId: 'a', evidenceReason: 'repeat_task', createdAt: '2026-09-13T02:00:00Z'},
    ]
    const items = buildRecentLearning([row('c', '2026-09-13T01:00:00Z')], all, lessons)
    assert.deepEqual(
      items.map((item) => item.kind),
      ['solution_practice', 'repeat_practice', 'lesson_watched'],
    )
  })

  it('is empty without any activity', () => {
    assert.deepEqual(buildRecentLearning([], [], lessons), [])
  })

  it('skips attempts with an invalid timestamp instead of failing the feed', () => {
    const attempts: RecentAttemptRow[] = [
      {lessonId: 'a', evidenceReason: 'hint_used', createdAt: new Date(Infinity)},
      {lessonId: 'a', evidenceReason: 'repeat_task', createdAt: 'not a date'},
      {lessonId: 'b', evidenceReason: 'first_independent_response', createdAt: '2026-09-13T02:00:00Z'},
    ]
    const items = buildRecentLearning([], attempts, lessons)
    assert.deepEqual(
      items.map((item) => [item.kind, item.at]),
      [['independent_practice', '2026-09-13T02:00:00.000Z']],
    )
  })
})

describe('buildOverviewState', () => {
  const course = {...ml, title: 'ML Foundations'}
  const ok = <T,>(value: T) => ({ok: true as const, value})
  const failed = {ok: false as const}
  const off: EvidenceState = {status: 'flag_disabled'}
  const allLessons = ok([lesson('a'), lesson('b'), lesson('c')])
  const saved = [row('a', '2026-09-12T10:00:00Z', {resumeSeconds: 522})]

  it('treats a learner with no rows as new, not as an error', () => {
    const state = buildOverviewState({progress: ok([]), courses: ok([]), feedLessons: ok([]), evidence: off})
    assert.deepEqual(state.nextStep, {kind: 'start'})
    assert.deepEqual(state.myCourses, {status: 'no_activity'})
    assert.deepEqual(state.recent, {status: 'no_activity'})
  })

  it('continues the saved lesson and summarises its course', () => {
    const state = buildOverviewState({progress: ok(saved), courses: ok([course]), feedLessons: allLessons, evidence: off})
    assert.deepEqual(state.nextStep, {kind: 'continue', course, lesson: lesson('a'), resumeSeconds: 522})
    assert.deepEqual(state.myCourses, {status: 'ready', course, completedLessons: 0, totalLessons: 3})
    assert.equal(state.recent.status, 'ready')
  })

  it('reports a failed progress read as an error on every progress card', () => {
    const state = buildOverviewState({progress: failed, courses: ok([]), feedLessons: ok([]), evidence: off})
    assert.deepEqual(state.nextStep, {kind: 'error'})
    assert.deepEqual(state.myCourses, {status: 'error'})
    assert.deepEqual(state.recent, {status: 'error'})
  })

  it('reports failed course or lesson-title reads as errors when there is activity', () => {
    const noCourses = buildOverviewState({progress: ok(saved), courses: failed, feedLessons: allLessons, evidence: off})
    assert.deepEqual([noCourses.nextStep, noCourses.myCourses], [{kind: 'error'}, {status: 'error'}])
    const noTitles = buildOverviewState({progress: ok(saved), courses: ok([course]), feedLessons: failed, evidence: off})
    assert.deepEqual(noTitles.recent, {status: 'error'})
  })

  it('distinguishes progress whose lessons are no longer published', () => {
    const orphan = [row('gone', '2026-09-12T10:00:00Z')]
    const state = buildOverviewState({progress: ok(orphan), courses: ok([]), feedLessons: ok([]), evidence: off})
    assert.deepEqual(state.nextStep, {kind: 'missing_content'})
    assert.deepEqual(state.myCourses, {status: 'missing_content'})
    assert.deepEqual(state.recent, {status: 'missing_content'})
  })

  it('offers browsing once the course is complete', () => {
    const done = ['a', 'b', 'c'].map((id) => row(id, '2026-09-12T10:00:00Z', {completed: true}))
    const state = buildOverviewState({progress: ok(done), courses: ok([course]), feedLessons: allLessons, evidence: off})
    assert.deepEqual(state.nextStep, {kind: 'course_complete', course})
  })

  it('continues unfinished work in another course when the newest course is complete', () => {
    const webCourse = {...web, title: 'Web Basics'}
    const cssCourse = {_id: 'course-css', title: 'CSS', modules: [{_key: 'm1', lessons: [lesson('z')]}]}
    const rows = [
      row('z', '2026-09-09T10:00:00Z', {resumeSeconds: 40}),
      row('b', '2026-09-10T10:00:00Z', {resumeSeconds: 120}),
      row('x', '2026-09-12T10:00:00Z', {completed: true}),
      row('y', '2026-09-12T11:00:00Z', {completed: true}),
    ]
    const state = buildOverviewState({
      progress: ok(rows),
      courses: ok([course, webCourse, cssCourse]),
      feedLessons: ok([lesson('b'), lesson('x'), lesson('y'), lesson('z')]),
      evidence: off,
    })
    // My Courses still shows the most recently active course; the next step goes to the newest unfinished lesson.
    assert.deepEqual(state.myCourses, {status: 'ready', course: webCourse, completedLessons: 2, totalLessons: 2})
    assert.deepEqual(state.nextStep, {kind: 'continue', course, lesson: lesson('b'), resumeSeconds: 120})
  })

  it('keeps loaded activity but flags an evidence failure; without activity it is an error', () => {
    for (const evidence of [{status: 'error'}, {status: 'not_configured'}] as EvidenceState[]) {
      const withRows = buildOverviewState({progress: ok(saved), courses: ok([course]), feedLessons: allLessons, evidence})
      assert.equal(withRows.recent.status === 'ready' && withRows.recent.partial, true)
      const none = buildOverviewState({progress: ok([]), courses: ok([]), feedLessons: ok([]), evidence})
      assert.deepEqual(none.recent, {status: 'error'})
    }
  })
})

describe('conceptStatState', () => {
  const ready: EvidenceState = {status: 'ready', recentAttempts: [], independentConceptIds: []}
  it('hides the stat when evidence is off or the course has no servable concepts', () => {
    assert.deepEqual(conceptStatState({status: 'flag_disabled'}, null), {status: 'hidden'})
    assert.deepEqual(conceptStatState(ready, {ok: true, value: null}), {status: 'hidden'})
  })
  it('shows an error for evidence or concept read failures', () => {
    assert.deepEqual(conceptStatState({status: 'error'}, null), {status: 'error'})
    assert.deepEqual(conceptStatState({status: 'not_configured'}, null), {status: 'error'})
    assert.deepEqual(conceptStatState(ready, {ok: false}), {status: 'error'})
  })
  it('shows the counts when available', () => {
    assert.deepEqual(conceptStatState(ready, {ok: true, value: {withEvidence: 0, total: 4}}), {
      status: 'ready',
      value: {withEvidence: 0, total: 4},
    })
  })
})
