import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {evaluate, parse} from 'groq-js'

import {HINT_LADDER_QUERY} from '../../sanity/queries/assessments.ts'
import {hintText, MAX_HINT_LENGTH, toHintLadder} from './hints.ts'

/**
 * The PR-5 hint ladder query evaluated over full documents: which delivered
 * versions can still give help, and that nothing beyond the ladder and the
 * correct option id is selected.
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
    answerKey: {correctOptionId: 'opt-a', correctReason: SECRET, distractorReasons: [{optionId: 'opt-b', reason: SECRET}]},
    hints: {direction: 'Think about what survives a render.', keyConcept: 'State persists between renders.', solution: 'useState stores it.'},
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
  assessment('assessment-nosolution-v1', {hints: {direction: 'Look.', keyConcept: 'Rule.'}}),
  assessment('assessment-blankhint-v1', {hints: {direction: '   ', keyConcept: 'Rule.', solution: 'Answer.'}}),
]

async function run(assessmentId: string) {
  return (await evaluate(parse(HINT_LADDER_QUERY), {dataset: DATASET, params: {assessmentId}})).get()
}

const ladder = async (assessmentId: string) => toHintLadder(await run(assessmentId))

describe('HINT_LADDER_QUERY', () => {
  it('returns the reviewed ladder and correct option id for a servable version', async () => {
    assert.deepEqual(await ladder('assessment-fam1-v2'), {
      _id: 'assessment-fam1-v2',
      familyId: 'fam1',
      version: 2,
      optionIds: ['opt-a', 'opt-b', 'opt-c'],
      correctOptionId: 'opt-a',
      direction: 'Think about what survives a render.',
      keyConcept: 'State persists between renders.',
      solution: 'useState stores it.',
    })
  })

  it('still serves a delivered older version that stays approved and current', async () => {
    assert.equal((await ladder('assessment-fam1-v1'))?.version, 1)
  })

  it('refuses stale, withdrawn, draft, orphaned, and missing items', async () => {
    for (const id of [
      'assessment-stale-v1',
      'assessment-review-v1',
      'assessment-archived-v1',
      'drafts.assessment-draft-v1',
      'assessment-orphan-v1',
      'assessment-missing-v1',
    ]) {
      assert.equal(await ladder(id), null, id)
    }
  })

  it('treats a missing or blank rung as unavailable instead of improvising one', async () => {
    assert.equal(await ladder('assessment-nosolution-v1'), null)
    assert.equal(await ladder('assessment-blankhint-v1'), null)
  })

  it('selects no reasons, excerpt, or concept', async () => {
    const raw = JSON.stringify(await run('assessment-fam1-v2'))
    for (const leak of [SECRET, 'correctReason', 'distractorReasons', 'primaryConcept', 'question']) assert.ok(!raw.includes(leak), leak)
  })
})

describe('toHintLadder', () => {
  const row = {
    _id: 'assessment-x-v1',
    familyId: 'x',
    version: 1,
    optionIds: ['a', 'b', 'c'],
    correctOptionId: 'a',
    direction: 'One.',
    keyConcept: 'Two.',
    solution: 'Three.',
  }

  it('rejects an answer key naming no option, duplicate options, and overlong rungs', () => {
    assert.ok(toHintLadder(row))
    assert.equal(toHintLadder({...row, correctOptionId: 'z'}), null)
    assert.equal(toHintLadder({...row, optionIds: ['a', 'a', 'b']}), null)
    assert.equal(toHintLadder({...row, solution: 'x'.repeat(MAX_HINT_LENGTH + 1)}), null)
  })

  it('rejects draft ids and unexpected fields', () => {
    assert.equal(toHintLadder({...row, _id: 'drafts.assessment-x-v1'}), null)
    assert.equal(toHintLadder({...row, correctReason: 'x'}), null)
    assert.equal(toHintLadder(null), null)
  })

  it('maps each level to exactly one rung', () => {
    const parsed = toHintLadder(row)!
    assert.deepEqual([1, 2, 3].map((level) => hintText(parsed, level as 1 | 2 | 3)), ['One.', 'Two.', 'Three.'])
  })
})
