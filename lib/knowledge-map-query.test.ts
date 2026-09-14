import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {evaluate, parse} from 'groq-js'

import {KNOWLEDGE_MAP_EDGES_QUERY, KNOWLEDGE_MAP_PROPOSED_EDGES_QUERY} from '../sanity/queries/my-learning.ts'

/**
 * Evaluates the knowledge map's real edge GROQ over a raw dataset mixing
 * published edges, generator drafts, and editorial decisions: the graph read
 * sees only published approved edges; the display-only proposal read sees
 * only unreviewed, current drafts with status "proposed".
 */

const ref = (id: string) => ({_type: 'reference', _ref: id})

function edge(id: string, overrides: Record<string, unknown> = {}) {
  return {
    _id: id,
    _type: 'conceptPrerequisite',
    status: 'proposed',
    sourceStatus: 'current',
    prerequisite: ref('concept-cpt-a'),
    dependent: ref('concept-cpt-b'),
    rationale: `Rationale of ${id}.`,
    evidence: [
      {_key: 'k0', _type: 'conceptSourceRef', chunkId: 'c0', chunkRevision: 'r0', startSeconds: 12, endSeconds: 30, lesson: ref('lesson-1')},
      {_key: 'k1', _type: 'conceptSourceRef', chunkId: 'c1', chunkRevision: 'r1', startSeconds: 95, endSeconds: 110, lesson: ref('lesson-2')},
    ],
    ...overrides,
  }
}

const dataset = [
  edge('concept-prereq-approved', {status: 'approved'}),
  edge('concept-prereq-approved-stale', {status: 'approved', sourceStatus: 'stale'}),
  edge('drafts.concept-prereq-approved', {status: 'approved', rationale: 'Unpublished edit.'}),
  edge('drafts.concept-prereq-proposed'),
  edge('drafts.concept-prereq-rejected', {status: 'rejected'}),
  edge('drafts.concept-prereq-retired', {status: 'retired'}),
  edge('drafts.concept-prereq-stale', {sourceStatus: 'stale'}),
  edge('drafts.concept-prereq-approved-unpublished', {status: 'approved'}),
  edge('versions.r1.concept-prereq-proposed', {}),
  edge('drafts.concept-prereq-off-map', {dependent: ref('concept-cpt-z')}),
  edge('concept-prereq-published-proposed', {status: 'proposed'}),
]

async function run(query: string) {
  const result = await evaluate(parse(query), {dataset, params: {conceptIds: ['concept-cpt-a', 'concept-cpt-b']}})
  return (await result.get()) as Array<{id: string; rationale: string; evidence: unknown}>
}

describe('knowledge map edge queries', () => {
  it('reads only published, approved, current edges into the graph', async () => {
    const rows = await run(KNOWLEDGE_MAP_EDGES_QUERY)
    assert.deepEqual(rows.map((row) => row.id), ['concept-prereq-approved'])
    assert.equal(rows[0].rationale, 'Rationale of concept-prereq-approved.')
    assert.deepEqual(rows[0].evidence, [
      {lessonId: 'lesson-1', startSeconds: 12},
      {lessonId: 'lesson-2', startSeconds: 95},
    ])
  })

  it('reads only unreviewed, current proposal drafts for display', async () => {
    const rows = await run(KNOWLEDGE_MAP_PROPOSED_EDGES_QUERY)
    // Not: published edges of any status, rejected/retired/stale drafts, editor-approved drafts, release versions, or off-map pairs.
    assert.deepEqual(rows.map((row) => row.id), ['drafts.concept-prereq-proposed'])
    assert.deepEqual(rows[0].evidence, [
      {lessonId: 'lesson-1', startSeconds: 12},
      {lessonId: 'lesson-2', startSeconds: 95},
    ])
  })
})
