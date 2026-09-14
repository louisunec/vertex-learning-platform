import assert from 'node:assert/strict'
import {after, before, beforeEach, describe, it} from 'node:test'

import postgres from 'postgres'

import type {GraphEdge} from '../concepts/graph.ts'
import type {ProgressRow} from '../course-progress.ts'
import {isRetryableDatabaseError} from '../db/errors.ts'
import {asLearner} from '../db/learner-scope.ts'
import {createTestDatabase, SKIP_WITHOUT_DATABASE, type TestDatabase} from '../db/test-db.ts'
import {submitAttempt} from './attempts.ts'
import {ContentUnavailableError} from './content-source.ts'
import {readGoal, saveCourseGoal, setLearningGoal} from './goal.ts'
import {nextLessonTask} from './lesson-check.ts'
import {planNextActions, type NextActionCapabilities} from './next-action.ts'
import {nextActionResponseSchema, type NextActionResponse} from './next-action-contracts.ts'
import type {GoalCourse, NextActionContentSource, PlanConcept} from './next-action-source.ts'
import {startReviewSession} from './review-session.ts'
import {FixtureContent} from './test-content.ts'

/**
 * The next-action service and goal store against a real migrated database
 * under the RLS-bound learner role, with in-memory content. Evidence is
 * produced only through the real services (lesson check, focused review,
 * attempts), so the plan is shown to change with newly recorded evidence,
 * never with a recommendation being shown.
 */

const ALICE = 'user_alice'
const BOB = 'user_bob'
const COURSE = 'course-react'
const NOW = new Date('2026-09-14T10:00:00.000Z')

let keySeq = 0
const key = () => `key-${String(++keySeq).padStart(16, '0')}`

const COURSE_DOC: GoalCourse = {
  _id: COURSE,
  title: 'React Foundations',
  slug: 'react-foundations',
  summary: 'State and effects.',
  lessons: [
    {_id: 'lesson-hooks', title: 'Hooks', slug: 'hooks', durationSeconds: 900},
    {_id: 'lesson-effects', title: 'Effects', slug: 'effects', durationSeconds: 600},
  ],
}

const STATE: PlanConcept = {
  id: 'concept-cpt-state',
  conceptId: 'cpt-state',
  name: 'Component state',
  sources: [
    {chunkId: 'v1:tc-10', lessonId: 'lesson-hooks', startSeconds: 300, endSeconds: 330},
    {chunkId: 'v1:tc-11', lessonId: 'lesson-hooks', startSeconds: 330, endSeconds: 362},
  ],
}
const EFFECT: PlanConcept = {
  id: 'concept-cpt-effect',
  conceptId: 'cpt-effect',
  name: 'Effects',
  sources: [{chunkId: 'v2:tc-2', lessonId: 'lesson-effects', startSeconds: 60, endSeconds: 95}],
}

/** Plan content over `FixtureContent`'s items; `fail` makes one read throw like a Sanity outage. */
class FixturePlanContent implements NextActionContentSource {
  courses = new Map<string, GoalCourse>([[COURSE, COURSE_DOC]])
  progress = new Map<string, ProgressRow[]>()
  concepts: PlanConcept[] = [STATE, EFFECT]
  edges: GraphEdge[] = [{id: 'edge-state-effect', prerequisite: STATE.id, dependent: EFFECT.id, status: 'approved'}]
  fail: 'concepts' | null = null
  readonly items: FixtureContent

  constructor(items: FixtureContent) {
    this.items = items
  }

  loadConceptIndex() {
    return this.items.loadConceptIndex()
  }
  loadReviewCandidates(refs: string[]) {
    return this.items.loadReviewCandidates(refs)
  }
  async loadGoalCourses() {
    return [...this.courses.values()].map(({_id, title, slug}) => ({_id, title, slug}))
  }
  async loadCourse(courseId: string) {
    return this.courses.get(courseId) ?? null
  }
  async loadProgress(learnerId: string) {
    return this.progress.get(learnerId) ?? []
  }
  async loadCourseConcepts(lessonIds: string[]) {
    if (this.fail === 'concepts') throw new ContentUnavailableError('Concepts could not be read')
    return this.concepts.filter((concept) => concept.sources.some((source) => lessonIds.includes(source.lessonId)))
  }
  async loadPrerequisiteEdges(conceptIds: string[]) {
    return this.edges.filter((edge) => edge.dependent && conceptIds.includes(edge.dependent))
  }
  async loadCourseCheckCandidates(lessonIds: string[]) {
    return (await Promise.all(lessonIds.map((lessonId) => this.items.loadLessonCheckCandidates(lessonId)))).flat()
  }
}

const ALL_ON: NextActionCapabilities = {practice: true, checks: true}

describe('next actions and learning goals', {skip: SKIP_WITHOUT_DATABASE}, () => {
  let db: TestDatabase
  let items: FixtureContent
  let content: FixturePlanContent

  before(async () => {
    db = await createTestDatabase()
  })
  after(() => db?.drop())

  beforeEach(async () => {
    // Cascade also empties later tables that reference these (PR-9's review_log). A table they don't
    // reference, such as PR-9's review_card, must be listed wherever it exists.
    await db.sql`
      truncate learner.learning_goal, learner.review_session_item, learner.review_session, learner.tutor_request,
               learner.event_outbox, learner.concept_mastery, learner.help_event, learner.attempt_log, learner.task_instance
      cascade
    `
    items = new FixtureContent()
    items.concepts.set(STATE.id, {id: STATE.id, conceptId: STATE.conceptId, reviewStatus: 'approved'})
    items.concepts.set(EFFECT.id, {id: EFFECT.id, conceptId: EFFECT.conceptId, reviewStatus: 'approved'})
    items.lessons.set('lesson-effects', {title: 'Effects', slug: 'effects'})
    items.addItem('fam-a', {firstSeconds: 300})
    items.addItem('fam-b', {firstSeconds: 330})
    items.addItem('fam-e', {concept: EFFECT.id, lessonId: 'lesson-effects', firstSeconds: 60})
    content = new FixturePlanContent(items)
  })

  const plan = async (learnerId: string, capabilities = ALL_ON, request: {courseId?: string} = {}): Promise<NextActionResponse> => {
    const outcome = await planNextActions({db: db.sql, content, learnerId, request, capabilities, now: NOW})
    assert.equal(outcome.status, 'ok', JSON.stringify(outcome))
    return outcome.status === 'ok' ? nextActionResponseSchema.parse(outcome.body) : assert.fail()
  }
  const ready = (body: NextActionResponse) => (body.status === 'ready' ? body : assert.fail(`expected a plan, got ${body.status}`))
  const ids = (body: NextActionResponse) => ready(body).items.map((item) => item.id)
  const counts = async () =>
    (
      await db.sql<{attempts: number; mastery: number; help: number; tasks: number}[]>`
        select (select count(*)::int from learner.attempt_log) as attempts,
               (select count(*)::int from learner.concept_mastery) as mastery,
               (select count(*)::int from learner.help_event) as help,
               (select count(*)::int from learner.task_instance) as tasks
      `
    )[0]

  /** Takes the lesson check's next question through PR-7 and answers it through PR-4. */
  async function answerCheck(learnerId: string, lessonId: string, optionId: string) {
    const outcome = await nextLessonTask({db: db.sql, content: items, learnerId, request: {lessonId, kind: 'check'}, now: NOW})
    const body = outcome.status === 'ok' && outcome.body.status === 'issued' ? outcome.body : assert.fail(JSON.stringify(outcome))
    const graded = await submitAttempt({
      db: db.sql,
      content: items,
      learnerId,
      request: {taskInstanceId: body.task.taskInstanceId, optionId, idempotencyKey: key()},
      now: NOW,
    })
    assert.equal(graded.status, 'graded')
    return body.task.item.familyId
  }

  it('asks for a goal instead of inferring one, even when the learner has progress', async () => {
    content.progress.set(ALICE, [{lessonId: 'lesson-hooks', completed: false, resumeSeconds: 40, updatedAt: '2026-09-13T00:00:00Z'}])
    assert.deepEqual(await plan(ALICE), {status: 'no_goal'})
    assert.equal(await readGoal(db.sql, ALICE), null)
  })

  it('saves only a published course the learner chose, and keeps each learner’s goal private', async () => {
    const missing = await setLearningGoal({db: db.sql, content, learnerId: ALICE, request: {courseId: 'course-unpublished'}, now: NOW})
    assert.deepEqual(missing, {status: 'rejected', code: 'not_found'})
    assert.equal(await readGoal(db.sql, ALICE), null)

    const saved = await setLearningGoal({db: db.sql, content, learnerId: ALICE, request: {courseId: COURSE}, now: NOW})
    assert.equal(saved.status, 'ok')
    assert.deepEqual(saved.status === 'ok' && saved.body.course, {id: COURSE, title: 'React Foundations', slug: 'react-foundations'})
    assert.equal((await readGoal(db.sql, ALICE))?.courseId, COURSE)
    assert.equal(await readGoal(db.sql, BOB), null)

    // Under Bob's identity, Alice's row can be neither read nor changed.
    const touched = await asLearner(db.sql, BOB, async (tx) => {
      const seen = await tx`select 1 from learner.learning_goal`
      const changed = await tx`update learner.learning_goal set course_id = 'course-bob' where learner_id = ${ALICE}`
      return [seen.length, changed.count]
    })
    assert.deepEqual(touched, [0, 0])
    await assert.rejects(
      asLearner(db.sql, BOB, (tx) => tx`insert into learner.learning_goal (learner_id, course_id) values (${ALICE}, 'course-bob')`),
      /row-level security/,
    )
    assert.equal((await readGoal(db.sql, ALICE))?.courseId, COURSE)
  })

  it('keeps the first choice time when the same goal is saved again, and replaces it on change', async () => {
    await saveCourseGoal(db.sql, ALICE, COURSE, NOW)
    const same = await saveCourseGoal(db.sql, ALICE, COURSE, new Date(NOW.getTime() + 60_000))
    assert.equal(same.setAt.toISOString(), NOW.toISOString())
    const changed = await saveCourseGoal(db.sql, ALICE, 'course-other', new Date(NOW.getTime() + 120_000))
    assert.deepEqual([changed.courseId, changed.setAt.toISOString()], ['course-other', new Date(NOW.getTime() + 120_000).toISOString()])
  })

  it('starts a cold learner with lesson checks, and holds back a concept whose prerequisite is unproven', async () => {
    await saveCourseGoal(db.sql, ALICE, COURSE, NOW)
    const body = ready(await plan(ALICE))
    assert.deepEqual(ids(body), ['diagnose:lesson-hooks', 'diagnose:lesson-effects', 'learn:cpt-state', 'next:lesson-effects'])
    assert.deepEqual(body.notices, [])
    const learn = body.items[2]
    assert.equal(learn.href, '/lessons/hooks?t=300')
    assert.deepEqual(learn.span, {startSeconds: 300, endSeconds: 362})
    assert.deepEqual(learn.provenance.sourceChunkIds, ['v1:tc-10', 'v1:tc-11'])

    // Without the check route, the same learner gets an honest course-order plan.
    const noChecks = ready(await plan(ALICE, {practice: true, checks: false}))
    assert.deepEqual(ids(noChecks), ['learn:cpt-state', 'next:lesson-effects'])
    assert.ok(noChecks.notices.includes('no_evidence_no_check'))
  })

  it('reads only: building plans writes no evidence, tasks, or help', async () => {
    await saveCourseGoal(db.sql, ALICE, COURSE, NOW)
    const before = await counts()
    for (let i = 0; i < 3; i++) await plan(ALICE)
    assert.deepEqual(await counts(), before)
  })

  it('changes the plan after new graded evidence, and keeps learners apart', async () => {
    await saveCourseGoal(db.sql, ALICE, COURSE, NOW)
    await saveCourseGoal(db.sql, BOB, COURSE, NOW)

    // Alice misses the first check question on her own.
    assert.equal(await answerCheck(ALICE, 'lesson-hooks', 'opt-b'), 'fam-a')
    const afterMiss = ready(await plan(ALICE))
    const [practise] = afterMiss.items
    assert.equal(practise.kind, 'practise')
    assert.equal(practise.href, '/my-learning/reviews')
    assert.equal(practise.actionLabel, 'Start focused review')
    assert.equal(practise.reason, 'Your last answer on Component state, given on your own, was incorrect.')
    assert.deepEqual(practise.provenance.evidence.map((trace) => [trace.conceptId, trace.state, trace.independentIncorrect]), [
      ['cpt-state', 'needs_practice', 1],
    ])
    assert.ok(!ids(afterMiss).includes('diagnose:lesson-hooks'), 'the answered concept is no longer offered as a first check')

    // Without focused review, the same evidence yields a revisit of the source span instead.
    const revisit = ready(await plan(ALICE, {practice: false, checks: true})).items[0]
    assert.deepEqual([revisit.reasonCode, revisit.href], ['weak_evidence_revisit', '/lessons/hooks?t=300'])

    // Bob's plan is untouched by Alice's answers.
    assert.deepEqual(ids(await plan(BOB)), ['diagnose:lesson-hooks', 'diagnose:lesson-effects', 'learn:cpt-state', 'next:lesson-effects'])

    // Alice opens the focused review: the plan now resumes that session.
    const session = await startReviewSession({db: db.sql, content: items, learnerId: ALICE, now: NOW})
    const open = session.status === 'active' ? session.items.find((item) => item.state === 'open') : undefined
    assert.ok(open && open.state === 'open')
    assert.equal(ready(await plan(ALICE)).items[0].actionLabel, 'Resume focused review')

    // She answers the unseen same-concept question correctly on her own: the prerequisite is now demonstrated.
    const graded = await submitAttempt({
      db: db.sql,
      content: items,
      learnerId: ALICE,
      request: {taskInstanceId: open.task.taskInstanceId, optionId: 'opt-a', idempotencyKey: key()},
      now: NOW,
    })
    assert.equal(graded.status, 'graded')
    const afterPractice = ready(await plan(ALICE))
    assert.ok(!afterPractice.items.some((item) => item.kind === 'practise'))
    const effect = afterPractice.items.find((item) => item.id === 'learn:cpt-effect')!
    assert.equal(effect.reasonCode, 'prerequisites_demonstrated')
    assert.equal(effect.reason, 'You answered its prerequisite Component state correctly on your own within the last 30 days.')
    assert.equal(effect.href, '/lessons/effects?t=60')
    assert.equal(afterPractice.items[0].id, 'learn:cpt-effect')
  })

  it('never lets an assisted answer demonstrate a prerequisite', async () => {
    await saveCourseGoal(db.sql, ALICE, COURSE, NOW)
    await db.sql`
      insert into learner.concept_mastery
        (learner_id, concept_id, assisted_correct, evidence_status, policy_version)
      values (${ALICE}, 'cpt-state', 3, 'assisted_only', 'evidence-v1')
    `
    const body = ready(await plan(ALICE, {practice: false, checks: false}))
    assert.ok(!body.items.some((item) => item.id === 'learn:cpt-effect'))
    const state = body.items.find((item) => item.concept?.conceptId === 'cpt-state')!
    assert.equal(state.reasonCode, 'weak_evidence_revisit')
    assert.match(state.reason, /used help, so there’s no independent answer yet/)
  })

  it('reports a withdrawn goal course, and refuses to preview a course that isn’t published', async () => {
    await saveCourseGoal(db.sql, ALICE, 'course-withdrawn', NOW)
    const body = await plan(ALICE)
    assert.deepEqual(body, {status: 'goal_unavailable', goal: {kind: 'course', courseId: 'course-withdrawn', setAt: NOW.toISOString()}})

    const preview = await planNextActions({db: db.sql, content, learnerId: ALICE, request: {courseId: 'course-missing'}, capabilities: ALL_ON, now: NOW})
    assert.deepEqual(preview, {status: 'rejected', code: 'not_found'})
    assert.equal(ready(await plan(ALICE, ALL_ON, {courseId: COURSE})).course.id, COURSE)
    assert.equal((await readGoal(db.sql, ALICE))?.courseId, 'course-withdrawn', 'a preview saves nothing')
  })

  it('fails loudly, never with an empty plan, when content or the learner database is unavailable', async () => {
    await saveCourseGoal(db.sql, ALICE, COURSE, NOW)
    content.fail = 'concepts'
    await assert.rejects(plan(ALICE), ContentUnavailableError)
    content.fail = null

    const unreachable = postgres('postgres://nobody@127.0.0.1:1/none', {max: 1, connect_timeout: 1, onnotice: () => {}})
    try {
      await assert.rejects(
        planNextActions({db: unreachable, content, learnerId: ALICE, request: {}, capabilities: ALL_ON, now: NOW}),
        (error) => isRetryableDatabaseError(error),
      )
    } finally {
      await unreachable.end()
    }
  })
})
