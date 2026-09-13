import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import type {CheckCandidate} from '../assessments/learner.ts'
import type {ConceptNode} from '../concepts/resolve.ts'
import {groupCandidates, selectCheckItem, selectFollowUp} from './lesson-check.ts'

function candidate(familyId: string, firstSeconds: number | null, primaryConceptRef: string | null = null): CheckCandidate {
  return {
    item: {
      _id: `assessment-${familyId}-v1`,
      _rev: 'rev',
      familyId,
      version: 1,
      lessonId: 'lesson-hooks',
      type: 'recall',
      responseFormat: 'single_choice',
      question: 'Q?',
      options: [
        {id: 'a', text: 'A'},
        {id: 'b', text: 'B'},
        {id: 'c', text: 'C'},
      ],
    },
    primaryConceptRef,
    firstSeconds,
  }
}

const node = (conceptId: string, reviewStatus = 'approved', mergedInto?: string): ConceptNode => ({
  id: `concept-${conceptId}`,
  conceptId,
  reviewStatus,
  ...(mergedInto ? {mergedInto} : {}),
})

const CONCEPTS = new Map<string, ConceptNode>([
  ['concept-state', node('state')],
  ['concept-effects', node('effects')],
  // An old id merged into `state`: its items belong to the same group.
  ['concept-old-state', node('old-state', 'merged', 'concept-state')],
  ['concept-draft', node('draft', 'needs_review')],
])

const families = (groups: ReturnType<typeof groupCandidates>) => groups.map((group) => group.candidates.map((c) => c.item.familyId))

describe('groupCandidates', () => {
  it('groups by resolved concept (through merges), in lesson order, with unconcepted items alone', () => {
    const groups = groupCandidates(
      [
        candidate('effects-2', 300, 'concept-effects'),
        candidate('state-2', 90, 'concept-old-state'),
        candidate('loose', 60),
        candidate('state-1', 30, 'concept-state'),
        candidate('effects-1', 200, 'concept-effects'),
        candidate('unreviewed', 10, 'concept-draft'),
        candidate('uncited', null, 'concept-state'),
      ],
      CONCEPTS,
    )
    assert.deepEqual(families(groups), [['unreviewed'], ['state-1', 'state-2', 'uncited'], ['loose'], ['effects-1', 'effects-2']])
    assert.deepEqual(
      groups.map((group) => group.conceptId),
      [null, 'state', null, 'effects'],
    )
  })

  it('breaks second ties by family id so selection is deterministic', () => {
    const groups = groupCandidates([candidate('b', 5), candidate('a', 5), candidate('c', null), candidate('d', null)], CONCEPTS)
    assert.deepEqual(families(groups), [['a'], ['b'], ['c'], ['d']])
  })
})

describe('selectCheckItem', () => {
  const groups = groupCandidates(
    [candidate('state-1', 30, 'concept-state'), candidate('state-2', 90, 'concept-state'), candidate('loose', 60), candidate('effects-1', 200, 'concept-effects')],
    CONCEPTS,
  )

  it('issues the first family of the first unanswered group, with grounded counts', () => {
    const selection = selectCheckItem(groups, new Set())
    assert.equal(selection.status, 'selected')
    assert.equal(selection.status === 'selected' && selection.candidate.item.familyId, 'state-1')
    assert.deepEqual(selection.status === 'selected' && selection.progress, {remaining: 3, total: 3})
  })

  it('treats a group as checked once any of its families was answered, keeping siblings for follow-ups', () => {
    for (const answered of [['state-1'], ['state-2']]) {
      const selection = selectCheckItem(groups, new Set(answered))
      assert.equal(selection.status === 'selected' && selection.candidate.item.familyId, 'loose')
      assert.deepEqual(selection.status === 'selected' && selection.progress, {remaining: 2, total: 3})
    }
  })

  it('reports no items and all checked honestly', () => {
    assert.deepEqual(selectCheckItem([], new Set()), {status: 'none', reason: 'no_items'})
    assert.deepEqual(selectCheckItem(groups, new Set(['state-1', 'loose', 'effects-1'])), {status: 'none', reason: 'all_checked'})
  })

  it('offers a sparse lesson one question, not an invented set', () => {
    const selection = selectCheckItem(groupCandidates([candidate('only', 5)], CONCEPTS), new Set())
    assert.deepEqual(selection.status === 'selected' && selection.progress, {remaining: 1, total: 1})
  })
})

describe('selectFollowUp', () => {
  const groups = groupCandidates(
    [
      candidate('state-1', 30, 'concept-state'),
      candidate('state-2', 90, 'concept-old-state'),
      candidate('state-3', 120, 'concept-state'),
      candidate('loose', 60),
    ],
    CONCEPTS,
  )

  it('issues an unanswered sibling on the same concept, never the answered family', () => {
    const selection = selectFollowUp(groups, new Set(['state-1']), 'state-1')
    assert.equal(selection.status === 'selected' && selection.candidate.item.familyId, 'state-2')
    assert.equal(selection.status === 'selected' && selection.progress, null)
  })

  it('skips siblings the learner already answered', () => {
    const selection = selectFollowUp(groups, new Set(['state-1', 'state-2']), 'state-1')
    assert.equal(selection.status === 'selected' && selection.candidate.item.familyId, 'state-3')
  })

  it('is unavailable without a concept, without an unanswered sibling, or when the item left the lesson', () => {
    assert.deepEqual(selectFollowUp(groups, new Set(['loose']), 'loose'), {status: 'none', reason: 'no_variant'})
    assert.deepEqual(selectFollowUp(groups, new Set(['state-1', 'state-2', 'state-3']), 'state-3'), {status: 'none', reason: 'no_variant'})
    assert.deepEqual(selectFollowUp(groups, new Set(['gone']), 'gone'), {status: 'none', reason: 'no_variant'})
  })
})
