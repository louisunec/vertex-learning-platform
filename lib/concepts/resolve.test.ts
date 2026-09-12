import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {MAX_MERGE_HOPS, resolveConcept, type ConceptNode} from './resolve.ts'

const node = (id: string, reviewStatus: string, extra: Partial<ConceptNode> = {}): ConceptNode => ({
  id,
  conceptId: id.replace(/^concept-/, ''),
  reviewStatus,
  ...extra,
})

const index = (...nodes: ConceptNode[]) => new Map(nodes.map((entry) => [entry.id, entry]))

describe('resolveConcept', () => {
  it('resolves an approved concept to itself', () => {
    assert.deepEqual(resolveConcept('concept-a', index(node('concept-a', 'approved'))), {
      status: 'active',
      id: 'concept-a',
      conceptId: 'a',
      path: ['concept-a'],
    })
  })

  it('follows a merge chain to the active concept and keeps the path as history', () => {
    const concepts = index(
      node('concept-a', 'merged', {mergedInto: 'concept-b'}),
      node('concept-b', 'merged', {mergedInto: 'concept-c'}),
      node('concept-c', 'approved'),
    )
    const resolution = resolveConcept('concept-a', concepts)
    assert.equal(resolution.status, 'active')
    assert.deepEqual(resolution.path, ['concept-a', 'concept-b', 'concept-c'])
    // The tombstone itself is untouched and still addressable.
    assert.equal(concepts.get('concept-a')?.reviewStatus, 'merged')
  })

  it('never collapses a split into one concept', () => {
    const resolution = resolveConcept('concept-a', index(node('concept-a', 'split', {splitInto: ['concept-b', 'concept-c']})))
    assert.deepEqual(resolution, {
      status: 'split',
      id: 'concept-a',
      into: ['concept-b', 'concept-c'],
      path: ['concept-a'],
      requiresReconciliation: true,
    })
  })

  it('reports missing, unreviewed, rejected, and archived concepts as unavailable', () => {
    const concepts = index(node('concept-d', 'needs_review'), node('concept-r', 'rejected'), node('concept-x', 'archived'))
    const reason = (id: string) => {
      const resolution = resolveConcept(id, concepts)
      return resolution.status === 'unavailable' ? resolution.reason : resolution.status
    }
    assert.equal(reason('concept-missing'), 'missing')
    assert.equal(reason('concept-d'), 'not_approved')
    assert.equal(reason('concept-r'), 'rejected')
    assert.equal(reason('concept-x'), 'archived')
  })

  it('detects merge cycles, over-deep chains, and invalid targets', () => {
    const cycle = index(node('concept-a', 'merged', {mergedInto: 'concept-b'}), node('concept-b', 'merged', {mergedInto: 'concept-a'}))
    const cyclic = resolveConcept('concept-a', cycle)
    assert.equal(cyclic.status === 'unavailable' && cyclic.reason, 'merge_cycle')

    const chain = Array.from({length: MAX_MERGE_HOPS + 2}, (_, i) => node(`concept-${i}`, 'merged', {mergedInto: `concept-${i + 1}`}))
    const deep = resolveConcept('concept-0', index(...chain))
    assert.equal(deep.status === 'unavailable' && deep.reason, 'merge_too_deep')

    const noTarget = resolveConcept('concept-a', index(node('concept-a', 'merged')))
    assert.equal(noTarget.status === 'unavailable' && noTarget.reason, 'invalid_merge_target')
    const oneWaySplit = resolveConcept('concept-a', index(node('concept-a', 'split', {splitInto: ['concept-b']})))
    assert.equal(oneWaySplit.status === 'unavailable' && oneWaySplit.reason, 'invalid_merge_target')
  })
})
