import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {
  CONSOLIDATION_SYSTEM_PROMPT,
  MAX_MERGE_GROUPS,
  MERGE_RATIONALE_LIMIT,
  buildConsolidationPrompt,
  consolidationKeyFor,
  consolidationOutputSchema,
  estimateConsolidatedCount,
  orderForConsolidation,
  planMergeProposals,
  proposalDocumentId,
  proposalSuppressionKey,
  toAcceptedMerge,
  type ConsolidationConcept,
  type ExistingProposal,
  type ProposedGroup,
} from './consolidate.ts'

const COURSE = 'course-web-security'
const NOW = new Date('2026-09-12T00:00:00Z')

const concept = (conceptId: string, candidateIds: string[] = [`cand-${conceptId}`]): ConsolidationConcept => ({
  conceptId,
  name: conceptId.replace(/^cpt-/, '').replace(/-/g, ' '),
  aliases: [],
  summary: `Summary of ${conceptId}.`,
  candidateIds,
  evidence: [0, 1].map((n) => ({
    _key: `ref-${conceptId}-${n}`,
    _type: 'conceptSourceRef' as const,
    chunkId: `video-x:${conceptId}-${n}`,
    chunkRevision: `rev-${n}`,
    startSeconds: n * 30,
    endSeconds: n * 30 + 30,
    lesson: {_type: 'reference' as const, _ref: 'lesson-a'},
    text: `Evidence ${n} for ${conceptId}.`,
  })),
})

// Out of order on purpose: prompt order is by concept id.
const concepts = orderForConsolidation([
  concept('cpt-csrf-risk-with-session-based-auth-and'),
  concept('cpt-authorization-roles-and-permissions'),
  concept('cpt-automatic-cookie-sending-enabling-csrf'),
  concept('cpt-authorization-access-control'),
  concept('cpt-xss'),
])
const [AUTHZ_ACCESS, AUTHZ_ROLES, COOKIE_SENDING, CSRF_RISK, XSS] = [0, 1, 2, 3, 4]

const group = (members: number[], overrides: Partial<ProposedGroup> = {}): ProposedGroup => ({
  members,
  canonical: members[0],
  relation: 'same_concept',
  rationale: 'Both describe the same concept.',
  evidence: [`k${members[0]}e0`],
  ...overrides,
})

const plan = (groups: ProposedGroup[], existing: ExistingProposal[] = []) =>
  planMergeProposals({
    output: {groups, skipReason: null},
    concepts,
    existing,
    courseId: COURSE,
    generationKey: 'key-1',
    model: 'gpt-5-mini',
    now: NOW,
  })

describe('consolidation contract and prompt', () => {
  it('bounds groups and group sizes', () => {
    const ok = {groups: [group([0, 1])], skipReason: null}
    assert.equal(consolidationOutputSchema.safeParse(ok).success, true)
    assert.equal(consolidationOutputSchema.safeParse({groups: [group([0])], skipReason: null}).success, false)
    assert.equal(consolidationOutputSchema.safeParse({groups: [group([0, 1, 2, 3, 4, 5, 6])], skipReason: null}).success, false)
    assert.equal(consolidationOutputSchema.safeParse({groups: Array.from({length: MAX_MERGE_GROUPS + 1}, () => group([0, 1])), skipReason: null}).success, false)
  })

  it('lists concepts by id with one evidence chunk each and keeps the critical rules inline, with no numeric target', () => {
    assert.deepEqual(concepts.map((entry) => entry.conceptId).slice(0, 2), ['cpt-authorization-access-control', 'cpt-authorization-roles-and-permissions'])
    const prompt = buildConsolidationPrompt({courseTitle: 'Web security', concepts})
    assert.match(prompt, /^k0 "authorization access control": "Summary of cpt-authorization-access-control\."$/m)
    assert.match(prompt, /^ {2}k0e0 /m)
    assert.doesNotMatch(prompt, /k0e1/)
    assert.match(CONSOLIDATION_SYSTEM_PROMPT, /untrusted source data/)
    assert.match(CONSOLIDATION_SYSTEM_PROMPT, /semantically equivalent/)
    assert.match(CONSOLIDATION_SYSTEM_PROMPT, /Never merge a sub-topic/)
    assert.match(CONSOLIDATION_SYSTEM_PROMPT, /Never merge an attack and its defence/)
    assert.match(CONSOLIDATION_SYSTEM_PROMPT, /a prerequisite and the concept that needs it/)
    assert.doesNotMatch(CONSOLIDATION_SYSTEM_PROMPT, /\b(40|60)\b concepts|target/i)
  })

  it('keys on every prompt input and the versions, not on input order', () => {
    const key = consolidationKeyFor({courseId: COURSE, concepts, model: 'gpt-5-mini'})
    assert.equal(consolidationKeyFor({courseId: COURSE, concepts: concepts.toReversed(), model: 'gpt-5-mini'}), key)
    const renamed = concepts.map((entry, i) => (i === 0 ? {...entry, summary: 'Changed.'} : entry))
    assert.notEqual(consolidationKeyFor({courseId: COURSE, concepts: renamed, model: 'gpt-5-mini'}), key)
  })
})

describe('planMergeProposals', () => {
  it('drafts a proposal with candidate ids, weak refs, server-mapped evidence, and an id from its suppression key', () => {
    const result = plan([group([AUTHZ_ROLES, AUTHZ_ACCESS], {canonical: AUTHZ_ACCESS, evidence: ['k1e0']})])
    assert.equal(result.drafts.length, 1)
    const [draft] = result.drafts
    const key = proposalSuppressionKey([concepts[AUTHZ_ACCESS], concepts[AUTHZ_ROLES]])
    assert.equal(draft._id, `drafts.${proposalDocumentId(key)}`)
    assert.equal(draft.status, 'proposed')
    assert.deepEqual(draft.canonical, {conceptId: 'cpt-authorization-access-control', candidateIds: ['cand-cpt-authorization-access-control']})
    assert.deepEqual(
      draft.members.map((member) => [member.conceptId, member.concept]),
      [
        ['cpt-authorization-access-control', {_type: 'reference', _ref: 'concept-cpt-authorization-access-control', _weak: true}],
        ['cpt-authorization-roles-and-permissions', {_type: 'reference', _ref: 'concept-cpt-authorization-roles-and-permissions', _weak: true}],
      ],
    )
    assert.deepEqual(draft.evidence.map((ref) => ref.chunkId), ['video-x:cpt-authorization-roles-and-permissions-0'])
    assert.equal('text' in draft.evidence[0], false)
    assert.deepEqual(result.groups[0].canonicalCandidateIds, ['cand-cpt-authorization-access-control'])
  })

  it('rejects sub-topic, related, and attack-and-defence groups before anything else, and stores no relation', () => {
    const result = plan([
      group([COOKIE_SENDING, CSRF_RISK], {relation: 'subtopic'}),
      group([AUTHZ_ACCESS, XSS], {relation: 'related'}),
      group([CSRF_RISK, XSS, 9], {relation: 'attack_and_defence'}),
      group([AUTHZ_ACCESS, AUTHZ_ROLES]),
    ])
    assert.deepEqual(
      result.rejections.map((rejection) => rejection.reason),
      ['not_equivalent:subtopic', 'not_equivalent:related', 'not_equivalent:attack_and_defence'],
    )
    assert.equal(result.drafts.length, 1)
    assert.equal(result.groups.length, 1)
    assert.equal('relation' in result.drafts[0], false)
    assert.equal('kind' in result.drafts[0], false)
  })

  it('rejects out-of-range indices, a single member, a canonical outside the group, and foreign evidence', () => {
    const result = plan([
      group([0, 9]),
      group([1, 1]),
      group([2, 3], {canonical: 4}),
      group([2, 3], {evidence: ['k4e0']}),
      group([2, 3], {evidence: ['k2e1']}),
    ])
    assert.deepEqual(result.drafts, [])
    assert.deepEqual(
      result.rejections.map((rejection) => rejection.reason),
      ['index_out_of_range', 'too_few_members', 'canonical_not_member', 'evidence_not_from_members', 'evidence_not_from_members'],
    )
  })

  it('rejects over-limit or cut-off rationale and a concept already used by an earlier group', () => {
    const result = plan([
      group([COOKIE_SENDING, CSRF_RISK]),
      group([CSRF_RISK, XSS]),
      group([AUTHZ_ACCESS, AUTHZ_ROLES], {rationale: `${'a'.repeat(MERGE_RATIONALE_LIMIT)}.`}),
      group([AUTHZ_ACCESS, AUTHZ_ROLES], {rationale: 'Both describe'}),
    ])
    assert.equal(result.drafts.length, 1)
    assert.deepEqual(
      result.rejections.map((rejection) => rejection.reason),
      ['overlapping_group', 'field_too_long:rationale', 'truncated_text:rationale'],
    )
  })

  it('suppresses a rejected proposal at the same key, keeps accepted and edited ones, and skips unchanged ones', () => {
    const [draft] = plan([group([AUTHZ_ACCESS, AUTHZ_ROLES])]).drafts
    const id = draft._id.replace(/^drafts\./, '')
    const existing = (overrides: Partial<ExistingProposal>): ExistingProposal => ({
      _id: draft._id,
      status: 'proposed',
      rationale: draft.rationale,
      canonicalConceptId: draft.canonical.conceptId,
      memberConceptIds: draft.members.map((member) => member.conceptId),
      evidenceChunkIds: draft.evidence.map((ref) => ref.chunkId),
      contentHash: draft.generation.contentHash,
      ...overrides,
    })
    const again = (prior: ExistingProposal) => plan([group([AUTHZ_ACCESS, AUTHZ_ROLES])], [prior])
    const rejected = again(existing({status: 'rejected'}))
    assert.deepEqual(rejected.rejections.map((entry) => entry.reason), ['suppressed_rejected'])
    assert.deepEqual(rejected.groups, [], 'a rejected proposal never feeds the hypothetical set')
    assert.deepEqual(again(existing({status: 'accepted'})).unchanged, [id])
    assert.deepEqual(again(existing({})).unchanged, [id])
    assert.deepEqual(again(existing({rationale: 'Edited.'})).rejections.map((entry) => entry.reason), ['editor_modified'])
  })

  it('gives changed members a new proposal id, so a rejection is reconsidered only when candidates or versions change', () => {
    const before = proposalSuppressionKey([concepts[AUTHZ_ACCESS], concepts[AUTHZ_ROLES]])
    const after = proposalSuppressionKey([concept('cpt-authorization-access-control', ['cand-new']), concepts[AUTHZ_ROLES]])
    assert.notEqual(proposalDocumentId(after), proposalDocumentId(before))
    // Inputs without candidate ids (the v1 file) fall back to concept ids and stay deterministic.
    const v1 = [concept('cpt-a', []), concept('cpt-b', [])]
    assert.equal(proposalSuppressionKey(v1), proposalSuppressionKey(v1.toReversed()))
  })
})

describe('helpers', () => {
  it('estimates the consolidated count and maps an accepted document to a merge', () => {
    assert.equal(estimateConsolidatedCount(88, [{members: [1, 2, 3]}, {members: [4, 5]}]), 85)
    assert.deepEqual(
      toAcceptedMerge({
        _id: 'drafts.concept-merge-abc',
        canonical: {candidateIds: ['cand-1']},
        members: [
          {conceptId: 'cpt-a', candidateIds: ['cand-1']},
          {conceptId: 'cpt-b', candidateIds: ['cand-2']},
        ],
      }),
      {
        proposalId: 'concept-merge-abc',
        canonicalCandidateIds: ['cand-1'],
        members: [
          {conceptId: 'cpt-a', candidateIds: ['cand-1']},
          {conceptId: 'cpt-b', candidateIds: ['cand-2']},
        ],
      },
    )
  })
})
