import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {toLearnerAssessments} from './learner.ts'

const row = (overrides: Record<string, unknown> = {}) => ({
  _id: 'assessment-asm-1-s0-q0-v1',
  _rev: 'rev1',
  familyId: 'asm-1-s0-q0',
  version: 1,
  lessonId: 'lesson-hooks',
  type: 'apply',
  responseFormat: 'single_choice',
  question: 'Which hook stores state?',
  options: [
    {id: 'opt-a', text: 'useState'},
    {id: 'opt-b', text: 'useEffect'},
    {id: 'opt-c', text: 'useMemo'},
  ],
  ...overrides,
})

describe('toLearnerAssessments', () => {
  it('passes a learner-safe row through', () => {
    assert.deepEqual(toLearnerAssessments([row()]), [row()])
  })

  it('drops rows that carry an answer key, hints, source text, or generation metadata', () => {
    for (const leak of [
      {answerKey: {correctOptionId: 'opt-a'}},
      {hints: {direction: 'x'}},
      {sourceExcerpt: 'transcript'},
      {generation: {model: 'gpt-5-mini'}},
    ]) {
      assert.deepEqual(toLearnerAssessments([row(leak)]), [], JSON.stringify(leak))
    }
  })

  it('drops rows whose options expose extra fields', () => {
    const options = [
      {id: 'opt-a', text: 'useState', correct: true},
      {id: 'opt-b', text: 'useEffect'},
      {id: 'opt-c', text: 'useMemo'},
    ]
    assert.deepEqual(toLearnerAssessments([row({options})]), [])
  })

  it('drops draft and release-version ids', () => {
    assert.deepEqual(
      toLearnerAssessments([row({_id: 'drafts.assessment-asm-1-s0-q0-v1'}), row({_id: 'versions.r1.assessment-x'})]),
      [],
    )
  })

  it('keeps only the latest version of each family', () => {
    const result = toLearnerAssessments([
      row({_id: 'assessment-asm-1-s0-q0-v1', version: 1}),
      row({_id: 'assessment-asm-1-s0-q0-v2', version: 2}),
      row({_id: 'assessment-asm-1-s0-q1-v1', familyId: 'asm-1-s0-q1'}),
    ])
    assert.deepEqual(
      result.map((item) => item._id),
      ['assessment-asm-1-s0-q0-v2', 'assessment-asm-1-s0-q1-v1'],
    )
  })

  it('returns nothing for non-array input', () => {
    assert.deepEqual(toLearnerAssessments(null), [])
  })
})
