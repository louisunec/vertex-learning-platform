import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {assessmentCoverage, findCycles, validateGraph, type GraphConcept, type GraphEdge} from './graph.ts'

const concept = (id: string, extra: Partial<GraphConcept> = {}): GraphConcept => ({
  id,
  conceptId: id.replace(/^concept-/, ''),
  reviewStatus: 'approved',
  accessible: true,
  ...extra,
})
const edge = (id: string, prerequisite: string | null, dependent: string | null, status = 'approved'): GraphEdge => ({
  id,
  prerequisite,
  dependent,
  status,
})
const codes = (result: ReturnType<typeof validateGraph>) => result.defects.map((defect) => defect.code).toSorted()

describe('findCycles', () => {
  it('returns strongly connected components with more than one node', () => {
    assert.deepEqual(findCycles([{from: 'a', to: 'b'}, {from: 'b', to: 'c'}]), [])
    assert.deepEqual(
      findCycles([
        {from: 'a', to: 'b'},
        {from: 'b', to: 'c'},
        {from: 'c', to: 'a'},
        {from: 'x', to: 'y'},
        {from: 'y', to: 'x'},
      ]),
      [
        ['a', 'b', 'c'],
        ['x', 'y'],
      ],
    )
  })
})

describe('validateGraph', () => {
  const concepts = [concept('concept-a'), concept('concept-b'), concept('concept-c')]

  it('accepts a valid DAG and ignores edges that are not approved', () => {
    const result = validateGraph({
      concepts,
      edges: [edge('e1', 'concept-a', 'concept-b'), edge('e2', 'concept-b', 'concept-c'), edge('e3', 'concept-c', 'concept-a', 'proposed')],
    })
    assert.equal(result.activeEdges, 2)
    assert.deepEqual(result.defects, [])
  })

  it('detects self-edges, duplicate pairs, dangling endpoints, and cycles', () => {
    const result = validateGraph({
      concepts,
      edges: [
        edge('self', 'concept-a', 'concept-a'),
        edge('dup1', 'concept-a', 'concept-b'),
        edge('dup2', 'concept-a', 'concept-b'),
        edge('back', 'concept-b', 'concept-a'),
        edge('dangling', 'concept-a', 'concept-gone'),
        edge('empty', null, 'concept-c'),
      ],
    })
    assert.deepEqual(codes(result), ['cycle', 'dangling_endpoint', 'dangling_endpoint', 'duplicate_pair', 'self_edge'])
    assert.deepEqual(result.defects.find((defect) => defect.code === 'cycle')?.edgeIds, ['back', 'dup1', 'dup2'])
  })

  it('flags tombstone, unreviewed, and inaccessible endpoints', () => {
    const result = validateGraph({
      concepts: [
        concept('concept-a'),
        concept('concept-merged', {reviewStatus: 'merged', mergedInto: 'concept-a'}),
        concept('concept-draft', {reviewStatus: 'needs_review'}),
        concept('concept-hidden', {accessible: false}),
      ],
      edges: [
        edge('e1', 'concept-merged', 'concept-a'),
        edge('e2', 'concept-a', 'concept-draft'),
        edge('e3', 'concept-hidden', 'concept-a'),
      ],
    })
    assert.deepEqual(codes(result), ['inaccessible_endpoint', 'inactive_endpoint', 'inactive_endpoint'])
  })
})

describe('assessmentCoverage', () => {
  const concepts = [
    {...concept('concept-a'), sourceChunkIds: ['v:1', 'v:2']},
    {...concept('concept-b'), sourceChunkIds: ['v:3']},
    concept('concept-old', {reviewStatus: 'merged', mergedInto: 'concept-a'}),
    concept('concept-split', {reviewStatus: 'split', splitInto: ['concept-a', 'concept-b']}),
  ]

  it('resolves links through merges without losing the original reference', () => {
    const report = assessmentCoverage({
      scope: ['concept-a', 'concept-b'],
      concepts,
      assessments: [{id: 'asm-1', primaryConcept: 'concept-old', sourceChunkIds: []}],
    })
    assert.deepEqual(report.viaMerge, [{assessmentId: 'asm-1', from: 'concept-old', to: 'concept-a'}])
    assert.deepEqual(report.uncovered, ['concept-b'])
  })

  it('suggests links by chunk overlap, flags splits, and reports unresolved links', () => {
    const report = assessmentCoverage({
      scope: ['concept-a', 'concept-b'],
      concepts,
      assessments: [
        {id: 'asm-unlinked', primaryConcept: null, sourceChunkIds: ['v:3', 'v:1', 'v:2']},
        {id: 'asm-split', primaryConcept: 'concept-split', sourceChunkIds: []},
        {id: 'asm-gone', primaryConcept: 'concept-gone', sourceChunkIds: []},
      ],
    })
    assert.deepEqual(report.unlinked, [{assessmentId: 'asm-unlinked', suggestions: ['concept-a', 'concept-b']}])
    assert.deepEqual(report.needsReconciliation, [{assessmentId: 'asm-split', conceptId: 'concept-split', into: ['concept-a', 'concept-b']}])
    assert.deepEqual(report.unresolved, [{assessmentId: 'asm-gone', conceptId: 'concept-gone', reason: 'missing'}])
    assert.deepEqual(report.uncovered, ['concept-a', 'concept-b'])
  })
})
