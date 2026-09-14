import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {evaluate, parse} from 'groq-js'

import {
  COURSE_CHECK_CANDIDATES_QUERY,
  GOAL_COURSES_QUERY,
  NEXT_ACTION_CONCEPTS_QUERY,
  NEXT_ACTION_COURSE_QUERY,
  NEXT_ACTION_EDGES_QUERY,
} from '../sanity/queries/next-action.ts'
import {toCheckCandidates} from './assessments/learner.ts'
import {toGoalCourse, toPlanConcepts, toPrerequisiteEdges, toProgressRows} from './learner/next-action-source.ts'

/**
 * Evaluates the planner's real GROQ over a dataset mixing published and
 * draft documents, as the learner-read rules require: only published,
 * approved, current concepts and edges; only published courses and lessons;
 * only servable check items; and no private assessment fields.
 */

const SECRET = 'SECRET-ANSWER-KEY-REASON'

const ref = (id: string) => ({_type: 'reference', _ref: id})

function conceptDoc(id: string, overrides: Record<string, unknown> = {}) {
  return {
    _id: id,
    _type: 'concept',
    conceptId: id.replace(/^(drafts\.)?concept-/, ''),
    name: `Name of ${id}`,
    reviewStatus: 'approved',
    sourceStatus: 'current',
    lessons: [ref('lesson-1')],
    sourceRefs: [
      {_key: 'a', chunkId: 'v:tc-1', chunkRevision: 'r1', startSeconds: 60, endSeconds: 90, lesson: ref('lesson-1')},
      {_key: 'b', chunkId: 'v:tc-9', chunkRevision: 'r1', startSeconds: 10, endSeconds: 20, lesson: ref('lesson-elsewhere')},
    ],
    sourceExcerpt: 'SECRET-TRANSCRIPT',
    ...overrides,
  }
}

function edgeDoc(id: string, prerequisite: string, dependent: string, overrides: Record<string, unknown> = {}) {
  return {_id: id, _type: 'conceptPrerequisite', status: 'approved', sourceStatus: 'current', prerequisite: ref(prerequisite), dependent: ref(dependent), rationale: 'r', ...overrides}
}

function assessmentDoc(id: string, lessonId: string, overrides: Record<string, unknown> = {}) {
  return {
    _id: id,
    _rev: 'rev',
    _type: 'assessment',
    familyId: id.replace(/^(drafts\.)?assessment-/, '').replace(/-v\d+$/, ''),
    version: Number(id.match(/-v(\d+)$/)?.[1] ?? 1),
    lesson: ref(lessonId),
    type: 'apply',
    responseFormat: 'single_choice',
    question: 'Which one?',
    options: [
      {_key: 'opt-a', text: 'A'},
      {_key: 'opt-b', text: 'B'},
      {_key: 'opt-c', text: 'C'},
    ],
    answerKey: {correctOptionId: 'opt-a', correctReason: SECRET},
    hints: {direction: SECRET, keyConcept: SECRET, solution: SECRET},
    primaryConcept: ref('concept-cpt-a'),
    sourceChunkRefs: [{_key: 'x', startSeconds: 42, endSeconds: 60}],
    reviewStatus: 'approved',
    sourceStatus: 'current',
    ...overrides,
  }
}

const DATASET = [
  {_id: 'course-1', _type: 'course', title: 'Security', slug: {current: 'security'}, summary: 'S', modules: [
    {_key: 'm1', lessons: [ref('lesson-1'), ref('lesson-draft-only')]},
    {_key: 'm2', lessons: [ref('lesson-2'), ref('lesson-1')]},
  ]},
  {_id: 'drafts.course-1', _type: 'course', title: 'Security (draft edit)', slug: {current: 'security'}},
  {_id: 'drafts.course-new', _type: 'course', title: 'Unpublished course', slug: {current: 'new'}},
  {_id: 'course-noslug', _type: 'course', title: 'No slug'},
  {_id: 'lesson-1', _type: 'lesson', title: 'One', slug: {current: 'one'}, durationSeconds: 600},
  {_id: 'lesson-2', _type: 'lesson', title: 'Two', slug: {current: 'two'}},
  {_id: 'drafts.lesson-draft-only', _type: 'lesson', title: 'Draft only', slug: {current: 'draft-only'}},
  conceptDoc('concept-cpt-a'),
  conceptDoc('concept-cpt-b', {lessons: [ref('lesson-2')], sourceRefs: [{_key: 'c', chunkId: 'v:tc-2', startSeconds: 5, endSeconds: 25, lesson: ref('lesson-2')}]}),
  conceptDoc('drafts.concept-cpt-a', {name: 'Draft rename'}),
  conceptDoc('drafts.concept-cpt-new'),
  conceptDoc('concept-cpt-rejected', {reviewStatus: 'rejected'}),
  conceptDoc('concept-cpt-review', {reviewStatus: 'needs_review'}),
  conceptDoc('concept-cpt-stale', {sourceStatus: 'stale'}),
  conceptDoc('concept-cpt-merged', {reviewStatus: 'merged', mergedInto: ref('concept-cpt-a')}),
  conceptDoc('concept-cpt-other', {lessons: [ref('lesson-elsewhere')]}),
  edgeDoc('edge-ok', 'concept-cpt-a', 'concept-cpt-b'),
  edgeDoc('edge-external', 'concept-cpt-other', 'concept-cpt-a'),
  edgeDoc('drafts.edge-draft', 'concept-cpt-a', 'concept-cpt-b'),
  edgeDoc('edge-proposed', 'concept-cpt-b', 'concept-cpt-a', {status: 'proposed'}),
  edgeDoc('edge-rejected', 'concept-cpt-b', 'concept-cpt-a', {status: 'rejected'}),
  edgeDoc('edge-stale', 'concept-cpt-b', 'concept-cpt-a', {sourceStatus: 'stale'}),
  edgeDoc('edge-unrelated', 'concept-cpt-a', 'concept-cpt-other'),
  assessmentDoc('assessment-fam1-v1', 'lesson-1'),
  assessmentDoc('assessment-fam1-v2', 'lesson-1'),
  assessmentDoc('assessment-fam2-v1', 'lesson-1', {reviewStatus: 'needs_review'}),
  assessmentDoc('assessment-fam3-v1', 'lesson-2', {sourceStatus: 'stale'}),
  assessmentDoc('drafts.assessment-fam4-v1', 'lesson-2'),
  assessmentDoc('assessment-fam5-v1', 'lesson-draft-only'),
  assessmentDoc('assessment-fam6-v1', 'lesson-2'),
  assessmentDoc('assessment-fam7-v1', 'lesson-elsewhere'),
]

async function run(query: string, params: Record<string, unknown>) {
  return (await evaluate(parse(query), {dataset: DATASET, params})).get()
}

describe('next-action queries', () => {
  it('lists only published courses with a slug as goal options', async () => {
    const rows = await run(GOAL_COURSES_QUERY, {})
    assert.deepEqual(rows, [{_id: 'course-1', title: 'Security', slug: 'security'}])
  })

  it('reads a published course with its published lessons in order, once each', async () => {
    const course = toGoalCourse(await run(NEXT_ACTION_COURSE_QUERY, {courseId: 'course-1'}))
    assert.deepEqual(course, {
      _id: 'course-1',
      title: 'Security',
      slug: 'security',
      summary: 'S',
      lessons: [
        {_id: 'lesson-1', title: 'One', slug: 'one', durationSeconds: 600},
        {_id: 'lesson-2', title: 'Two', slug: 'two', durationSeconds: null},
      ],
    })
    for (const courseId of ['drafts.course-new', 'course-new', 'course-noslug', 'missing']) {
      assert.equal(await run(NEXT_ACTION_COURSE_QUERY, {courseId}), null, courseId)
    }
  })

  it('reads only published, approved, current concepts in the lessons, with their sources there', async () => {
    const concepts = toPlanConcepts(await run(NEXT_ACTION_CONCEPTS_QUERY, {lessonIds: ['lesson-1', 'lesson-2']}))
    assert.deepEqual(
      concepts.map((concept) => concept.id),
      ['concept-cpt-a', 'concept-cpt-b'],
    )
    assert.equal(concepts[0].name, 'Name of concept-cpt-a')
    assert.deepEqual(concepts[0].sources, [{chunkId: 'v:tc-1', lessonId: 'lesson-1', startSeconds: 60, endSeconds: 90}])
    assert.ok(!JSON.stringify(concepts).includes('SECRET'))
  })

  it('reads only published, approved, current edges into the given concepts', async () => {
    const edges = toPrerequisiteEdges(await run(NEXT_ACTION_EDGES_QUERY, {conceptIds: ['concept-cpt-a', 'concept-cpt-b']}))
    assert.deepEqual(
      edges.map((edge) => edge.id),
      ['edge-external', 'edge-ok'],
    )
  })

  it('reads servable check items for the lessons, latest version per family, without private fields', async () => {
    const rows = await run(COURSE_CHECK_CANDIDATES_QUERY, {lessonIds: ['lesson-1', 'lesson-2', 'lesson-draft-only']})
    assert.ok(!JSON.stringify(rows).includes(SECRET))
    const candidates = toCheckCandidates(rows)
    assert.deepEqual(
      candidates.map((candidate) => [candidate.item._id, candidate.primaryConceptRef, candidate.firstSeconds]),
      [
        ['assessment-fam1-v2', 'concept-cpt-a', 42],
        ['assessment-fam6-v1', 'concept-cpt-a', 42],
      ],
    )
  })
})

describe('next-action row parsers', () => {
  it('drops rows it cannot trust rather than guessing', () => {
    assert.equal(toGoalCourse({_id: 'c', title: '', slug: 's'}), null)
    assert.deepEqual(toGoalCourse({_id: 'c', title: 'T', slug: 's', modules: [null, {lessons: [null, {_id: 'l', title: 'L'}]}]})?.lessons, [])
    assert.deepEqual(toPlanConcepts([{id: 'x', conceptId: 'cpt-x', name: 'X', sources: [{lessonId: 'l', startSeconds: -1}, {lessonId: 'l', startSeconds: 3}]}])[0].sources, [
      {chunkId: null, lessonId: 'l', startSeconds: 3, endSeconds: null},
    ])
    assert.deepEqual(toProgressRows([{lessonId: 'l', resumeSeconds: 12}, {completed: true}]), [
      {lessonId: 'l', completed: null, resumeSeconds: 12, updatedAt: null},
    ])
    assert.deepEqual(toPrerequisiteEdges('not rows'), [])
  })
})
