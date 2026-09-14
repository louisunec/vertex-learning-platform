import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {evaluate, parse} from 'groq-js'

import {CONCEPT_NODES_QUERY, GRADING_ASSESSMENT_QUERY, SERVABLE_ASSESSMENT_QUERY} from '../../sanity/queries/assessments.ts'
import {resolveConcept} from '../concepts/resolve.ts'
import {toConceptIndex, toGradingItem} from './grading.ts'
import {toLearnerAssessments} from './learner.ts'

/**
 * The PR-4 content queries evaluated over full documents: which items can be
 * issued, which delivered versions can still be graded, and that the
 * learner-facing projection never carries grading data.
 */

const LESSON = {_id: 'lesson-hooks', _type: 'lesson', title: 'Hooks'}
const SECRET = 'SECRET-TEXT'

function assessment(id: string, overrides: Record<string, unknown> = {}) {
  return {
    _id: id,
    _rev: `rev-${id}`,
    _type: 'assessment',
    familyId: id.replace(/^(drafts\.)?assessment-/, '').replace(/-v\d+$/, ''),
    version: Number(id.match(/-v(\d+)$/)?.[1] ?? 1),
    lesson: {_type: 'reference', _ref: LESSON._id},
    objective: 'Choose the hook that stores state.',
    type: 'apply',
    responseFormat: 'single_choice',
    question: 'Which hook keeps a value between renders?',
    options: [
      {_key: 'opt-a', _type: 'assessmentOption', text: 'useState'},
      {_key: 'opt-b', _type: 'assessmentOption', text: 'useEffect'},
      {_key: 'opt-c', _type: 'assessmentOption', text: 'useMemo'},
    ],
    answerKey: {correctOptionId: 'opt-a', correctReason: SECRET, distractorReasons: []},
    hints: {direction: SECRET, keyConcept: SECRET, solution: SECRET},
    sourceExcerpt: SECRET,
    primaryConcept: {_type: 'reference', _ref: 'concept-cpt-state'},
    reviewStatus: 'approved',
    sourceStatus: 'current',
    ...overrides,
  }
}

const DATASET = [
  LESSON,
  assessment('assessment-fam1-v1'),
  assessment('assessment-fam1-v2'),
  assessment('assessment-stale-v1', {sourceStatus: 'stale'}),
  assessment('assessment-review-v1', {reviewStatus: 'needs_review'}),
  assessment('assessment-archived-v1', {reviewStatus: 'archived'}),
  assessment('drafts.assessment-draft-v1'),
  assessment('assessment-orphan-v1', {lesson: {_type: 'reference', _ref: 'lesson-unpublished'}}),
  assessment('assessment-noconcept-v1', {primaryConcept: undefined}),
]

async function run(query: string, params: Record<string, unknown>, dataset: unknown[] = DATASET) {
  return (await evaluate(parse(query), {dataset, params})).get()
}

describe('SERVABLE_ASSESSMENT_QUERY', () => {
  const issue = async (assessmentId: string) =>
    toLearnerAssessments([await run(SERVABLE_ASSESSMENT_QUERY, {assessmentId})].filter(Boolean))[0] ?? null

  it('issues the latest approved, current version with a published lesson', async () => {
    const item = await issue('assessment-fam1-v2')
    assert.equal(item?._id, 'assessment-fam1-v2')
    assert.deepEqual(item?.options.map((option) => option.id), ['opt-a', 'opt-b', 'opt-c'])
  })

  it('does not issue superseded, stale, unreviewed, archived, draft, or orphaned items', async () => {
    for (const id of [
      'assessment-fam1-v1',
      'assessment-stale-v1',
      'assessment-review-v1',
      'assessment-archived-v1',
      'drafts.assessment-draft-v1',
      'assessment-orphan-v1',
      'assessment-missing-v1',
    ]) {
      assert.equal(await issue(id), null, id)
    }
  })

  it('projects nothing private', async () => {
    const raw = JSON.stringify(await run(SERVABLE_ASSESSMENT_QUERY, {assessmentId: 'assessment-fam1-v2'}))
    for (const leak of [SECRET, 'answerKey', 'correctOptionId', 'hints', 'primaryConcept']) assert.ok(!raw.includes(leak), leak)
  })
})

describe('GRADING_ASSESSMENT_QUERY', () => {
  const grading = async (assessmentId: string) => toGradingItem(await run(GRADING_ASSESSMENT_QUERY, {assessmentId}))

  it('returns the answer key and primary concept for a gradable version', async () => {
    assert.deepEqual(await grading('assessment-fam1-v2'), {
      _id: 'assessment-fam1-v2',
      familyId: 'fam1',
      version: 2,
      lessonId: 'lesson-hooks',
      type: 'apply',
      optionIds: ['opt-a', 'opt-b', 'opt-c'],
      correctOptionId: 'opt-a',
      primaryConceptRef: 'concept-cpt-state',
    })
  })

  it('still grades a delivered older version that stays approved and current', async () => {
    assert.equal((await grading('assessment-fam1-v1'))?.version, 1)
  })

  it('reports a missing primary concept as null', async () => {
    assert.equal((await grading('assessment-noconcept-v1'))?.primaryConceptRef, null)
  })

  it('refuses stale, withdrawn, draft, and orphaned items', async () => {
    for (const id of ['assessment-stale-v1', 'assessment-review-v1', 'assessment-archived-v1', 'drafts.assessment-draft-v1', 'assessment-orphan-v1']) {
      assert.equal(await grading(id), null, id)
    }
  })
})

describe('toGradingItem', () => {
  const row = {
    _id: 'assessment-x-v1',
    familyId: 'x',
    version: 1,
    lessonId: 'l',
    type: 'recall',
    optionIds: ['a', 'b', 'c'],
    correctOptionId: 'a',
    primaryConceptRef: null,
  }

  it('rejects rows whose answer key names no option, or with duplicate option ids', () => {
    assert.ok(toGradingItem(row))
    assert.equal(toGradingItem({...row, correctOptionId: 'z'}), null)
    assert.equal(toGradingItem({...row, optionIds: ['a', 'a', 'b']}), null)
  })

  it('rejects draft ids and unexpected fields', () => {
    assert.equal(toGradingItem({...row, _id: 'drafts.assessment-x-v1'}), null)
    assert.equal(toGradingItem({...row, hints: {}}), null)
    assert.equal(toGradingItem(null), null)
  })
})

describe('CONCEPT_NODES_QUERY', () => {
  const concepts = [
    {_id: 'concept-cpt-old', _type: 'concept', conceptId: 'cpt-old', reviewStatus: 'merged', mergedInto: {_ref: 'concept-cpt-state'}, summary: SECRET},
    {_id: 'concept-cpt-state', _type: 'concept', conceptId: 'cpt-state', reviewStatus: 'approved', summary: SECRET},
    {_id: 'drafts.concept-cpt-new', _type: 'concept', conceptId: 'cpt-new', reviewStatus: 'approved'},
  ]

  it('returns published ids and statuses only, enough to resolve merges', async () => {
    const rows = await run(CONCEPT_NODES_QUERY, {}, concepts)
    assert.ok(!JSON.stringify(rows).includes(SECRET))
    const index = toConceptIndex(rows)
    assert.deepEqual([...index.keys()], ['concept-cpt-old', 'concept-cpt-state'])
    const resolution = resolveConcept('concept-cpt-old', index)
    assert.equal(resolution.status === 'active' && resolution.conceptId, 'cpt-state')
  })
})
