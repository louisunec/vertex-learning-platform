import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {
  EDGE_RATIONALE_LIMIT,
  MAX_EVIDENCE_PER_CONCEPT,
  PREREQUISITE_SYSTEM_PROMPT,
  buildPrerequisitePrompt,
  edgeContentHash,
  edgeDocumentId,
  edgeSuppressionKey,
  orderForPrompt,
  planEdges,
  prerequisiteKeyFor,
  type EdgeConcept,
  type ExistingEdge,
  type PrerequisiteOutput,
  type ProposedEdge,
} from './prerequisites.ts'

const COURSE = 'course-web-security'
const NOW = new Date('2026-09-12T00:00:00Z')

const evidence = (conceptId: string, n: number) => ({
  _key: `ref-${conceptId}-${n}`,
  _type: 'conceptSourceRef' as const,
  chunkId: `video-x:tc-${conceptId}-${n}`,
  chunkRevision: `rev-${conceptId}-${n}`,
  startSeconds: n * 30,
  endSeconds: n * 30 + 30,
  lesson: {_type: 'reference' as const, _ref: 'lesson-a'},
  text: `Evidence ${n} for ${conceptId}.`,
})

const edgeConcept = (conceptId: string): EdgeConcept => ({
  conceptId,
  contentHash: `hash-${conceptId}`,
  name: conceptId.replace(/^cpt-/, ''),
  summary: `Summary of ${conceptId}.`,
  evidence: [evidence(conceptId, 0), evidence(conceptId, 1)],
})

// Deliberately out of order: the prompt lists concepts by id.
const concepts = orderForPrompt([edgeConcept('cpt-http-cookies'), edgeConcept('cpt-csrf'), edgeConcept('cpt-samesite')])
const [CSRF, COOKIES, SAMESITE] = [0, 1, 2]

const proposed = (prerequisite: number, dependent: number, overrides: Partial<ProposedEdge> = {}): ProposedEdge => ({
  prerequisite,
  dependent,
  rationale: 'The dependent concept is defined in terms of the prerequisite.',
  evidence: [`k${dependent}e0`],
  ...overrides,
})

const plan = (edges: ProposedEdge[], existing: ExistingEdge[] = [], activeEdges: Array<{prerequisite: string; dependent: string}> = []) =>
  planEdges({
    output: {edges, skipReason: null} satisfies PrerequisiteOutput,
    concepts,
    existing,
    activeEdges,
    courseId: COURSE,
    generationKey: 'key-1',
    model: 'gpt-5-mini',
    now: NOW,
  })

describe('prerequisite prompt', () => {
  it('lists concepts by id with bounded evidence, never in lesson order', () => {
    assert.deepEqual(
      concepts.map((concept) => concept.conceptId),
      ['cpt-csrf', 'cpt-http-cookies', 'cpt-samesite'],
    )
    assert.ok(concepts.every((concept) => concept.evidence.length === MAX_EVIDENCE_PER_CONCEPT))
    const prompt = buildPrerequisitePrompt({courseTitle: 'Web security', concepts})
    assert.match(prompt, /^k0 "csrf": "Summary of cpt-csrf\."$/m)
    assert.match(prompt, /^ {2}k0e0 "Evidence 0 for cpt-csrf\."$/m)
    assert.doesNotMatch(prompt, /k0e1/)
  })

  it('keeps the critical rules inline', () => {
    assert.match(PREREQUISITE_SYSTEM_PROMPT, /untrusted source data/)
    assert.match(PREREQUISITE_SYSTEM_PROMPT, /order in which a course covers topics is not a prerequisite/)
    assert.match(PREREQUISITE_SYSTEM_PROMPT, /similarity/)
  })

  it('keys on course, concept content, and versions — not on input order', () => {
    const key = prerequisiteKeyFor({courseId: COURSE, concepts, model: 'gpt-5-mini'})
    assert.equal(prerequisiteKeyFor({courseId: COURSE, concepts: concepts.toReversed(), model: 'gpt-5-mini'}), key)
    const changed = concepts.map((concept, i) => (i === 0 ? {...concept, contentHash: 'edited'} : concept))
    assert.notEqual(prerequisiteKeyFor({courseId: COURSE, concepts: changed, model: 'gpt-5-mini'}), key)
    assert.notEqual(prerequisiteKeyFor({courseId: COURSE, concepts, model: 'other'}), key)
  })
})

describe('planEdges', () => {
  it('drafts a proposed edge with a stable pair id and server-resolved evidence', () => {
    const result = plan([proposed(COOKIES, CSRF)])
    assert.equal(result.drafts.length, 1)
    const [draft] = result.drafts
    assert.equal(draft._id, `drafts.${edgeDocumentId('cpt-http-cookies', 'cpt-csrf')}`)
    assert.equal(draft.status, 'proposed')
    assert.deepEqual(draft.prerequisite, {_type: 'reference', _ref: 'concept-cpt-http-cookies'})
    assert.deepEqual(draft.dependent, {_type: 'reference', _ref: 'concept-cpt-csrf'})
    assert.deepEqual(
      draft.evidence.map((ref) => ref.chunkId),
      ['video-x:tc-cpt-csrf-0'],
    )
    assert.equal('text' in draft.evidence[0], false)
  })

  it('rejects self-edges, out-of-range indices, and evidence from other concepts', () => {
    const result = plan([
      proposed(CSRF, CSRF),
      proposed(CSRF, 9),
      proposed(COOKIES, CSRF, {evidence: ['k2e0']}),
      proposed(COOKIES, CSRF, {evidence: ['c0']}),
      proposed(COOKIES, CSRF, {evidence: ['k0e1']}),
    ])
    assert.deepEqual(result.drafts, [])
    assert.deepEqual(
      result.rejections.map((rejection) => rejection.reason),
      ['self_edge', 'index_out_of_range', 'evidence_not_from_endpoints', 'evidence_not_from_endpoints', 'evidence_not_from_endpoints'],
    )
  })

  it('rejects over-limit or cut-off rationale instead of truncating it', () => {
    const result = plan([
      proposed(COOKIES, CSRF, {rationale: `${'a'.repeat(EDGE_RATIONALE_LIMIT)}.`}),
      proposed(COOKIES, SAMESITE, {rationale: 'SameSite needs cookies because'}),
    ])
    assert.deepEqual(
      result.rejections.map((rejection) => rejection.reason),
      ['field_too_long:rationale', 'truncated_text:rationale'],
    )
  })

  it('keeps the first of duplicate proposals and rejects both directions of a pair', () => {
    const result = plan([proposed(COOKIES, CSRF), proposed(COOKIES, CSRF), proposed(COOKIES, SAMESITE), proposed(SAMESITE, COOKIES)])
    assert.deepEqual(
      result.drafts.map((draft) => draft._id),
      [`drafts.${edgeDocumentId('cpt-http-cookies', 'cpt-csrf')}`],
    )
    assert.deepEqual(
      result.rejections.map((rejection) => `${rejection.reason} ${rejection.pair}`).toSorted(),
      [
        'conflicting_direction cpt-http-cookies→cpt-samesite',
        'conflicting_direction cpt-samesite→cpt-http-cookies',
        'duplicate_edge cpt-http-cookies→cpt-csrf',
      ],
    )
  })

  it('never writes a published pair and leaves edited drafts alone', () => {
    const pair = {prerequisite: 'concept-cpt-http-cookies', dependent: 'concept-cpt-csrf'}
    const id = edgeDocumentId('cpt-http-cookies', 'cpt-csrf')
    const reason = (existing: ExistingEdge) => plan([proposed(COOKIES, CSRF)], [existing]).rejections.map((entry) => entry.reason)
    assert.deepEqual(reason({_id: id, status: 'approved', ...pair}), ['already_published'])
    assert.deepEqual(reason({_id: `drafts.${id}`, status: 'approved', ...pair}), ['editor_modified'])
    assert.deepEqual(reason({_id: `drafts.${id}`, status: 'proposed', rationale: 'Edited.', evidence: [], contentHash: 'stale', ...pair}), [
      'editor_modified',
    ])
  })

  it('suppresses a rejected pair only at the same suppression key and otherwise reconsiders it beside the rejected edge', () => {
    const pair = {prerequisite: 'concept-cpt-http-cookies', dependent: 'concept-cpt-csrf'}
    const id = edgeDocumentId('cpt-http-cookies', 'cpt-csrf')
    const key = edgeSuppressionKey(concepts[COOKIES], concepts[CSRF])
    const suppressed = plan([proposed(COOKIES, CSRF)], [{_id: `drafts.${id}`, status: 'rejected', suppressionKey: key, ...pair}])
    assert.deepEqual(suppressed.drafts, [])
    assert.deepEqual(suppressed.rejections.map((entry) => entry.reason), ['suppressed_rejected'])

    const olderVersions = plan([proposed(COOKIES, CSRF)], [{_id: `drafts.${id}`, status: 'rejected', suppressionKey: 'older', ...pair}])
    assert.equal(olderVersions.drafts.length, 1)
    const [reconsidered] = olderVersions.drafts
    assert.equal(reconsidered._id, `drafts.${edgeDocumentId('cpt-http-cookies', 'cpt-csrf', key)}`)
    assert.notEqual(reconsidered._id, `drafts.${id}`, 'the rejected edge is never written')
    assert.equal(reconsidered.status, 'proposed')
    assert.deepEqual(reconsidered.generation.reconsiders, [id])
    assert.equal(reconsidered.generation.suppressionKey, key)

    // A concept content change changes the key too.
    const edited = concepts.map((concept, i) => (i === CSRF ? {...concept, contentHash: 'changed'} : concept))
    assert.notEqual(edgeSuppressionKey(edited[COOKIES], edited[CSRF]), key)
  })

  it('writes nothing for an unchanged draft', () => {
    const [draft] = plan([proposed(COOKIES, CSRF)]).drafts
    const existing: ExistingEdge = {
      _id: draft._id,
      status: 'proposed',
      prerequisite: draft.prerequisite._ref,
      dependent: draft.dependent._ref,
      rationale: draft.rationale,
      evidence: draft.evidence,
      contentHash: draft.generation.contentHash,
    }
    assert.equal(
      edgeContentHash({prerequisite: 'cpt-http-cookies', dependent: 'cpt-csrf', rationale: draft.rationale, evidence: draft.evidence}),
      draft.generation.contentHash,
    )
    const again = plan([proposed(COOKIES, CSRF)], [existing])
    assert.deepEqual(again.drafts, [])
    assert.deepEqual(again.unchanged, ['cpt-http-cookies→cpt-csrf'])
  })

  it('reports cycles with published edges without resolving them', () => {
    const result = plan([proposed(COOKIES, CSRF)], [], [{prerequisite: 'concept-cpt-csrf', dependent: 'concept-cpt-http-cookies'}])
    assert.equal(result.drafts.length, 1)
    assert.deepEqual(result.cycles, [['concept-cpt-csrf', 'concept-cpt-http-cookies']])
  })
})
