import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {closedOnLoad, conceptProgress, nextOpenPosition, sessionSummary, type ActiveReview} from './focused-review.ts'

const item = {
  _id: 'assessment-a-v1',
  _rev: 'rev-1',
  familyId: 'a',
  version: 1,
  lessonId: 'lesson-1',
  type: 'apply' as const,
  responseFormat: 'single_choice' as const,
  question: 'Which loss?',
  options: [
    {id: 'opt-a', text: 'CrossEntropyLoss'},
    {id: 'opt-b', text: 'MSELoss'},
    {id: 'opt-c', text: 'L1Loss'},
  ],
}

const open = (position: number, conceptId: string) => ({
  position,
  conceptId,
  state: 'open' as const,
  task: {taskInstanceId: `00000000-0000-4000-8000-00000000000${position}`, expiresAt: '2026-09-15T00:00:00.000Z', item},
  refresher: null,
})

const SESSION: ActiveReview = {
  status: 'active',
  sessionId: '00000000-0000-4000-8000-000000000000',
  expiresAt: '2026-09-15T00:00:00.000Z',
  resumed: true,
  concepts: [
    {conceptId: 'cpt-loss', name: 'Loss functions', reason: 'assisted_correct'},
    {conceptId: 'cpt-grad', name: 'Autograd', reason: 'independent_incorrect'},
    {conceptId: 'cpt-metrics', name: null, reason: 'assisted_incorrect'},
  ],
  items: [
    {position: 1, conceptId: 'cpt-loss', state: 'answered'},
    open(2, 'cpt-loss'),
    {position: 3, conceptId: 'cpt-grad', state: 'unavailable'},
    open(4, 'cpt-grad'),
    open(5, 'cpt-metrics'),
  ],
}

describe('focused review view model', () => {
  it('summarizes counts, never time', () => {
    assert.equal(sessionSummary(SESSION), '3 concepts · 5 questions')
    assert.equal(sessionSummary({...SESSION, concepts: SESSION.concepts.slice(0, 1), items: [open(1, 'cpt-loss')]}), '1 concept · 1 question')
  })

  it('resumes at the first open question and skips closed ones', () => {
    const closed = closedOnLoad(SESSION)
    assert.deepEqual([...closed], [1, 3])
    assert.equal(nextOpenPosition(SESSION, closed), 2)
    assert.equal(nextOpenPosition(SESSION, new Set([...closed, 2]), 2), 4)
    assert.equal(nextOpenPosition(SESSION, closed, 5), null)
  })

  it('marks the current, finished, and upcoming concepts', () => {
    assert.deepEqual(
      conceptProgress(SESSION, new Set([1, 3]), 2).map((c) => [c.conceptId, c.status, c.label]),
      [
        ['cpt-loss', 'current', 'Current · question 2 of 5'],
        ['cpt-grad', 'next', 'Next'],
        ['cpt-metrics', 'next', 'Next'],
      ],
    )
    assert.deepEqual(
      conceptProgress(SESSION, new Set([1, 2, 3, 4, 5]), null).map((c) => c.status),
      ['done', 'done', 'done'],
    )
  })
})
