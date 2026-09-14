import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import type {CheckCandidate, LearnerAssessment} from '../assessments/learner.ts'
import type {ConceptNode} from '../concepts/resolve.ts'
import {planScheduled, type DueCard} from './scheduled-review.ts'

const index = new Map<string, ConceptNode>([
  ['concept-cpt-state', {id: 'concept-cpt-state', conceptId: 'cpt-state', reviewStatus: 'approved'}],
  ['concept-cpt-effects', {id: 'concept-cpt-effects', conceptId: 'cpt-effects', reviewStatus: 'approved'}],
  ['concept-cpt-old', {id: 'concept-cpt-old', conceptId: 'cpt-old', reviewStatus: 'merged', mergedInto: 'concept-cpt-state'}],
  ['concept-cpt-gone', {id: 'concept-cpt-gone', conceptId: 'cpt-gone', reviewStatus: 'archived'}],
])

function candidate(
  familyId: string,
  {concept = 'concept-cpt-state', type = 'apply' as LearnerAssessment['type'], firstSeconds = 100 as number | null} = {},
): CheckCandidate {
  return {
    item: {
      _id: `assessment-${familyId}-v1`,
      _rev: 'rev-1',
      familyId,
      version: 1,
      lessonId: 'lesson-1',
      type,
      responseFormat: 'single_choice',
      question: `Question ${familyId}?`,
      options: [
        {id: 'opt-a', text: 'A'},
        {id: 'opt-b', text: 'B'},
        {id: 'opt-c', text: 'C'},
      ],
    },
    primaryConceptRef: concept,
    firstSeconds,
  }
}

let n = 0
function card(conceptId: string, taskType: DueCard['taskType'], dueMinutesAgo: number): DueCard {
  return {id: `card-${++n}`, conceptId, taskType, due: new Date(Date.UTC(2026, 8, 14, 9) - dueMinutesAgo * 60 * 1000)}
}

const picked = (plan: ReturnType<typeof planScheduled>) => plan.items.map((item) => [item.candidate.item.familyId, item.repeat])

describe('planScheduled', () => {
  it('serves one item per due card, oldest due first, matching concept and item type', () => {
    const plan = planScheduled(
      [card('cpt-state', 'apply', 5), card('cpt-effects', 'recall', 50), card('cpt-state', 'recall', 20)],
      [candidate('s-apply'), candidate('s-recall', {type: 'recall'}), candidate('e-recall', {concept: 'concept-cpt-effects', type: 'recall'})],
      index,
      new Map(),
    )
    assert.deepEqual(picked(plan), [
      ['e-recall', false],
      ['s-recall', false],
      ['s-apply', false],
    ])
    assert.equal(plan.unavailable, 0)
  })

  it('prefers unseen families in cited order, then the one answered longest ago as a repeat', () => {
    const cards = [card('cpt-state', 'apply', 1)]
    const candidates = [candidate('late', {firstSeconds: 300}), candidate('early', {firstSeconds: 30}), candidate('seen-old'), candidate('seen-new')]
    const answered = new Map([
      ['seen-old', new Date('2026-09-01T00:00:00Z')],
      ['seen-new', new Date('2026-09-10T00:00:00Z')],
    ])
    assert.deepEqual(picked(planScheduled(cards, candidates, index, answered)), [['early', false]])
    const onlySeen = candidates.filter((c) => c.item.familyId.startsWith('seen'))
    assert.deepEqual(picked(planScheduled(cards, onlySeen, index, answered)), [['seen-old', true]])
  })

  it('never gives two cards the same family', () => {
    const plan = planScheduled([card('cpt-state', 'apply', 2), card('cpt-old', 'apply', 1)], [candidate('only')], index, new Map())
    assert.deepEqual(picked(plan), [['only', false]])
    assert.equal(plan.unavailable, 1)
  })

  it('follows merges to the successor concept, and leaves withdrawn or unmatched cards out', () => {
    const plan = planScheduled(
      [card('cpt-old', 'apply', 3), card('cpt-gone', 'apply', 2), card('cpt-state', 'transfer', 1)],
      [candidate('s-apply'), candidate('gone', {concept: 'concept-cpt-gone'})],
      index,
      new Map(),
    )
    assert.deepEqual(picked(plan), [['s-apply', false]])
    assert.equal(plan.items[0].card.conceptId, 'cpt-old')
    assert.equal(plan.unavailable, 2)
  })

  it('stops at five items without counting the rest as unavailable', () => {
    const cards = ['recall', 'apply', 'transfer'].flatMap((type, i) => [
      card('cpt-state', type as DueCard['taskType'], 10 + i),
      card('cpt-effects', type as DueCard['taskType'], 20 + i),
    ])
    const candidates = ['recall', 'apply', 'transfer'].flatMap((type) => [
      candidate(`s-${type}`, {type: type as LearnerAssessment['type']}),
      candidate(`e-${type}`, {concept: 'concept-cpt-effects', type: type as LearnerAssessment['type']}),
    ])
    const plan = planScheduled(cards, candidates, index, new Map())
    assert.equal(plan.items.length, 5)
    assert.equal(plan.unavailable, 0)
  })
})
