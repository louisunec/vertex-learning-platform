import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {
  MAX_CONCEPT_ALIASES,
  MAX_CONCEPT_ID_LENGTH,
  MAX_CONCEPT_SOURCE_REFS,
  assignConceptId,
  baseConceptId,
  conceptContentHash,
  matchKey,
  conceptSuppressionKey,
  planConcepts,
  type AcceptedMerge,
  type ConceptDraft,
  type ExistingConcept,
  type RecordedSpan,
} from './cluster.ts'
import {candidateFingerprint, type ConceptCandidate} from './extract.ts'

const COURSE = 'course-web-security'
const NOW = new Date('2026-09-12T00:00:00Z')

let refCounter = 0
const ref = (lessonId: string, startSeconds: number) => ({
  _key: `ref-${refCounter++}`,
  _type: 'conceptSourceRef' as const,
  chunkId: `video-${lessonId}:tc-${startSeconds}`,
  chunkRevision: `rev-${startSeconds}`,
  startSeconds,
  endSeconds: startSeconds + 30,
  lesson: {_type: 'reference' as const, _ref: lessonId},
})

const candidate = (name: string, lessonId: string, starts: number[], overrides: Partial<ConceptCandidate> = {}): ConceptCandidate => {
  const sourceRefs = starts.map((start) => ref(lessonId, start))
  return {
    _key: `cand-${lessonId}-${name}`,
    _type: 'conceptCandidate',
    role: 'primary',
    fingerprint: candidateFingerprint(name, sourceRefs.map((sourceRef) => sourceRef.chunkId)),
    name,
    aliases: [],
    summary: `${name} defined.`,
    objectives: [`Explain ${name}.`],
    sourceRefs,
    ...overrides,
  }
}

const span = (lessonId: string, lessonOrder: number, spanIndex: number, candidates: ConceptCandidate[]): RecordedSpan => ({
  lessonId,
  lessonOrder,
  spanIndex,
  extractionKey: `key-${lessonId}-${spanIndex}`,
  candidates,
})

const plan = (spans: RecordedSpan[], existing: ExistingConcept[] = [], acceptedMerges: AcceptedMerge[] = [], rejectedMerges: AcceptedMerge[] = []) =>
  planConcepts({spans, existing, courseId: COURSE, model: 'gpt-5-mini', chunkText: new Map(), now: NOW, acceptedMerges, rejectedMerges})

/** An existing concept document built from a draft, as the CLI would read it back. */
function existingFrom(draft: ConceptDraft, overrides: Partial<ExistingConcept> = {}): ExistingConcept {
  return {
    _id: draft._id,
    conceptId: draft.conceptId,
    name: draft.name,
    aliases: draft.aliases,
    summary: draft.summary,
    objectives: draft.objectives,
    sourceRefs: draft.sourceRefs,
    lessons: draft.lessons,
    reviewStatus: draft.reviewStatus,
    generationCourse: COURSE,
    contentHash: draft.generation.contentHash,
    suppressionKey: draft.generation.suppressionKey,
    appliedMerges: draft.generation.appliedMerges ?? null,
    ...overrides,
  }
}

describe('matchKey and concept ids', () => {
  it('matches case, punctuation, and plural variants lexically', () => {
    assert.equal(matchKey('CSRF Tokens'), matchKey('csrf-token'))
    assert.notEqual(matchKey('XSS'), matchKey('CSRF'))
  })

  it('builds ASCII kebab ids within the length cap and suffixes collisions', () => {
    assert.equal(baseConceptId('Cross-site request forgery (CSRF)'), 'cpt-cross-site-request-forgery-csrf')
    assert.equal(baseConceptId('Café sécurité'), 'cpt-cafe-securite')
    assert.ok(baseConceptId('x'.repeat(200)).length <= MAX_CONCEPT_ID_LENGTH)
    assert.equal(
      baseConceptId('Broken authentication (password reuse and defaults)'),
      'cpt-broken-authentication-password-reuse-and',
    )
    assert.equal(assignConceptId('CSRF', new Set(['cpt-csrf'])), 'cpt-csrf-2')
    assert.equal(assignConceptId('CSRF', new Set(['cpt-csrf', 'cpt-csrf-2'])), 'cpt-csrf-3')
  })
})

describe('planConcepts', () => {
  it('joins candidates sharing a name or alias across lessons and is deterministic', () => {
    const spans = [
      span('lesson-a', 0, 0, [candidate('CSRF tokens', 'lesson-a', [0], {aliases: ['Anti-CSRF token']})]),
      span('lesson-b', 1, 0, [candidate('Anti-CSRF tokens', 'lesson-b', [0, 30]), candidate('XSS', 'lesson-b', [60])]),
    ]
    const first = plan(spans)
    assert.equal(first.clusters, 2)
    assert.deepEqual(
      first.drafts.map((draft) => draft.conceptId),
      ['cpt-anti-csrf-tokens', 'cpt-xss'],
    )
    // The representative cites the most chunks; the other name becomes an alias.
    const csrf = first.drafts[0]
    assert.equal(csrf.name, 'Anti-CSRF tokens')
    assert.deepEqual(csrf.aliases, ['CSRF tokens'])
    assert.deepEqual(
      csrf.lessons.map((lesson) => lesson._ref),
      ['lesson-a', 'lesson-b'],
    )
    assert.equal(csrf._id, 'drafts.concept-cpt-anti-csrf-tokens')
    assert.equal(csrf.reviewStatus, 'needs_review')
    assert.deepEqual(plan(spans).drafts, first.drafts)
  })

  it('bounds aliases and source refs, keeping one ref per lesson first', () => {
    const lessons = Array.from({length: 3}, (_, i) => `lesson-${i}`)
    const spans = lessons.map((lessonId, order) =>
      span(lessonId, order, 0, [
        candidate('Input validation', lessonId, [0, 30, 60, 90], {
          aliases: Array.from({length: 5}, (_, a) => `validation alias ${order}-${a}`),
        }),
      ]),
    )
    const [draft] = plan(spans).drafts
    assert.equal(draft.aliases.length, MAX_CONCEPT_ALIASES)
    assert.equal(draft.sourceRefs.length, MAX_CONCEPT_SOURCE_REFS)
    assert.deepEqual(new Set(draft.sourceRefs.map((sourceRef) => sourceRef.lesson._ref)), new Set(lessons))
    assert.equal(plan(spans).droppedSourceRefs, 12 - MAX_CONCEPT_SOURCE_REFS)
  })

  it('reuses the id of a matching draft and writes nothing when its content is unchanged', () => {
    const spans = [span('lesson-a', 0, 0, [candidate('CSRF tokens', 'lesson-a', [0])])]
    const [draft] = plan(spans).drafts
    const again = plan(spans, [existingFrom(draft)])
    assert.deepEqual(again.drafts, [])
    assert.deepEqual(again.unchanged, [draft.conceptId])
  })

  it('keeps a stable id when the name changes but an alias overlaps', () => {
    const [draft] = plan([span('lesson-a', 0, 0, [candidate('CSRF tokens', 'lesson-a', [0])])]).drafts
    const renamed = [span('lesson-a', 0, 0, [candidate('Synchronizer tokens', 'lesson-a', [0], {aliases: ['CSRF token']})])]
    const next = plan(renamed, [existingFrom(draft)])
    assert.equal(next.drafts.length, 1)
    assert.equal(next.drafts[0].conceptId, draft.conceptId)
    assert.equal(next.drafts[0].name, 'Synchronizer tokens')
  })

  it('never writes a published concept and reports the evidence instead', () => {
    const [draft] = plan([span('lesson-a', 0, 0, [candidate('CSRF tokens', 'lesson-a', [0])])]).drafts
    const published = existingFrom(draft, {_id: 'concept-cpt-csrf-tokens', reviewStatus: 'approved'})
    const next = plan([span('lesson-b', 1, 0, [candidate('CSRF token', 'lesson-b', [90])])], [published])
    assert.deepEqual(next.drafts, [])
    assert.deepEqual(next.evidenceForPublished, [{conceptId: draft.conceptId, names: ['CSRF token']}])
  })

  it('leaves a draft an editor changed untouched', () => {
    const spans = [span('lesson-a', 0, 0, [candidate('CSRF tokens', 'lesson-a', [0])])]
    const [draft] = plan(spans).drafts
    const edited = existingFrom(draft, {summary: 'Edited by a reviewer.'})
    const next = plan([span('lesson-a', 0, 0, [candidate('CSRF tokens', 'lesson-a', [0, 30])])], [edited])
    assert.deepEqual(next.drafts, [])
    assert.deepEqual(next.editorModified, [draft.conceptId])
  })

  it('reports a cluster matching two existing concepts as a conflict and writes nothing', () => {
    const [a] = plan([span('lesson-a', 0, 0, [candidate('CSRF', 'lesson-a', [0])])]).drafts
    const [b] = plan([span('lesson-a', 0, 0, [candidate('SameSite cookies', 'lesson-a', [30])])]).drafts
    const bridging = [span('lesson-b', 1, 0, [candidate('CSRF', 'lesson-b', [0], {aliases: ['SameSite cookie']})])]
    const next = plan(bridging, [existingFrom(a), existingFrom(b)])
    assert.deepEqual(next.drafts, [])
    assert.deepEqual(next.conflicts, [{names: ['CSRF'], conceptIds: [a.conceptId, b.conceptId].toSorted()}])
  })

  it('suppresses a rejected concept only at the same source and generation versions', () => {
    const spans = [span('lesson-a', 0, 0, [candidate('Clickjacking', 'lesson-a', [0])])]
    const [draft] = plan(spans).drafts
    const rejected = existingFrom(draft, {reviewStatus: 'rejected'})
    const same = plan(spans, [rejected])
    assert.deepEqual(same.drafts, [])
    assert.deepEqual(same.suppressedRejected, [{conceptId: draft.conceptId, names: ['Clickjacking']}])
  })

  it('reconsiders a rejected concept as a new draft when its source changed, leaving the rejected one untouched', () => {
    const [draft] = plan([span('lesson-a', 0, 0, [candidate('Clickjacking', 'lesson-a', [0])])]).drafts
    const rejected = existingFrom(draft, {reviewStatus: 'rejected'})
    const changed = [span('lesson-a', 0, 0, [candidate('Clickjacking', 'lesson-a', [0, 30])])]
    const next = plan(changed, [rejected])
    assert.equal(next.drafts.length, 1)
    const [reconsidered] = next.drafts
    assert.equal(reconsidered.conceptId, `${draft.conceptId}-2`)
    assert.equal(reconsidered.reviewStatus, 'needs_review')
    assert.equal(reconsidered.generation.reconsiders, draft.conceptId)
    assert.ok(next.drafts.every((doc) => doc._id !== draft._id), 'the rejected document is never written')
    assert.deepEqual(next.reconsidered, [{conceptId: reconsidered.conceptId, reconsiders: draft.conceptId}])
    // Once a reconsidered draft exists, it is the match: no conflict, no second reconsideration.
    const again = plan(changed, [rejected, existingFrom(reconsidered)])
    assert.deepEqual(again.drafts, [])
    assert.deepEqual(again.unchanged, [reconsidered.conceptId])
  })

  it('keeps split and archived concepts terminal', () => {
    const [draft] = plan([span('lesson-a', 0, 0, [candidate('Clickjacking', 'lesson-a', [0])])]).drafts
    const next = plan([span('lesson-a', 0, 0, [candidate('Clickjacking', 'lesson-a', [0, 30])])], [existingFrom(draft, {reviewStatus: 'archived'})])
    assert.deepEqual(next.drafts, [])
    assert.equal(next.matchesRetired[0].reviewStatus, 'archived')
  })

  it('follows a merge tombstone to its successor when matching', () => {
    const [old] = plan([span('lesson-a', 0, 0, [candidate('CSRF', 'lesson-a', [0])])]).drafts
    const [target] = plan([span('lesson-a', 0, 0, [candidate('Cross-site request forgery', 'lesson-a', [30])])]).drafts
    const tombstone = existingFrom(old, {_id: 'concept-cpt-csrf', reviewStatus: 'merged', mergedInto: 'concept-cpt-cross-site-request-forgery'})
    const successor = existingFrom(target, {_id: 'concept-cpt-cross-site-request-forgery', reviewStatus: 'approved'})
    const next = plan([span('lesson-b', 1, 0, [candidate('CSRF', 'lesson-b', [60])])], [tombstone, successor])
    assert.deepEqual(next.conflicts, [])
    assert.deepEqual(next.evidenceForPublished.map((entry) => entry.conceptId), [target.conceptId])
  })

  it('lists unreproduced unedited drafts of this course for --force cleanup only', () => {
    const [gone] = plan([span('lesson-a', 0, 0, [candidate('Old idea', 'lesson-a', [0])])]).drafts
    const next = plan([span('lesson-a', 0, 0, [candidate('New idea', 'lesson-a', [0])])], [existingFrom(gone)])
    assert.deepEqual(next.unreproduced, [gone._id])
    const edited = plan([span('lesson-a', 0, 0, [candidate('New idea', 'lesson-a', [0])])], [existingFrom(gone, {summary: 'Edited.'})])
    assert.deepEqual(edited.unreproduced, [])
  })

  it('records candidate ids, role, and a suppression key on every draft', () => {
    const [draft] = plan([
      span('lesson-a', 0, 0, [candidate('XSS', 'lesson-a', [0], {role: 'secondary'})]),
      span('lesson-b', 1, 0, [candidate('XSS', 'lesson-b', [0])]),
    ]).drafts
    assert.deepEqual(draft.generation.candidateIds, ['cand-lesson-a-XSS', 'cand-lesson-b-XSS'])
    assert.equal(draft.generation.role, 'primary')
    assert.equal(draft.generation.suppressionKey.length, 32)
    assert.notEqual(conceptSuppressionKey([candidate('XSS', 'lesson-a', [0])]), conceptSuppressionKey([candidate('XSS', 'lesson-a', [30])]))
  })

  it('hashes content so any content change is visible', () => {
    const [draft] = plan([span('lesson-a', 0, 0, [candidate('CSRF tokens', 'lesson-a', [0])])]).drafts
    assert.equal(conceptContentHash(draft), draft.generation.contentHash)
    assert.notEqual(conceptContentHash({...draft, aliases: ['x']}), draft.generation.contentHash)
  })
})

describe('accepted merges', () => {
  const csrfRisk = candidate('CSRF risk with cookies', 'lesson-a', [0])
  const cookieSending = candidate('Automatic cookie sending', 'lesson-a', [30])
  const xss = candidate('XSS', 'lesson-a', [60])
  const spans = [span('lesson-a', 0, 0, [csrfRisk, cookieSending, xss])]
  const merge = (overrides: Partial<AcceptedMerge> = {}): AcceptedMerge => ({
    proposalId: 'concept-merge-1',
    canonicalCandidateIds: [csrfRisk._key],
    members: [
      {conceptId: 'cpt-csrf-risk-with-cookies', candidateIds: [csrfRisk._key]},
      {conceptId: 'cpt-automatic-cookie-sending', candidateIds: [cookieSending._key]},
    ],
    ...overrides,
  })

  it('joins the members by candidate id under the canonical concept', () => {
    const result = plan(spans, [], [merge()])
    assert.deepEqual(result.drafts.map((draft) => draft.conceptId), ['cpt-csrf-risk-with-cookies', 'cpt-xss'])
    const [merged] = result.drafts
    assert.deepEqual(merged.generation.candidateIds, [cookieSending._key, csrfRisk._key].toSorted())
    assert.deepEqual(merged.sourceRefs.map((sourceRef) => sourceRef.startSeconds), [0, 30])
    assert.deepEqual(merged.generation.appliedMerges, ['concept-merge-1'])
    assert.deepEqual(result.merges.applied, [{proposalId: 'concept-merge-1', conceptId: 'cpt-csrf-risk-with-cookies', members: []}])
  })

  it('folds member names into aliases (members are the same concept)', () => {
    assert.deepEqual(plan(spans, [], [merge()]).drafts[0].aliases, ['Automatic cookie sending'])
  })

  it('deletes the unedited non-canonical draft in the same plan and leaves an edited one', () => {
    const before = plan(spans).drafts
    const existing = before.map((draft) => existingFrom(draft))
    const result = plan(spans, existing, [merge()])
    assert.deepEqual(result.mergeDeletes, ['drafts.concept-cpt-automatic-cookie-sending'])
    assert.deepEqual(result.unreproduced, [])
    const edited = existing.map((doc) => (doc.conceptId === 'cpt-automatic-cookie-sending' ? {...doc, summary: 'Edited.'} : doc))
    const kept = plan(spans, edited, [merge()])
    assert.deepEqual(kept.mergeDeletes, [])
    assert.deepEqual(kept.merges.leftEdited, ['drafts.concept-cpt-automatic-cookie-sending'])
  })

  it('never applies a merge touching a published concept', () => {
    const before = plan(spans).drafts
    const existing = before.map((draft) =>
      existingFrom(draft, draft.conceptId === 'cpt-automatic-cookie-sending' ? {_id: 'concept-cpt-automatic-cookie-sending', reviewStatus: 'approved'} : {}),
    )
    const result = plan(spans, existing, [merge()])
    assert.deepEqual(result.merges.needsManual, [{proposalId: 'concept-merge-1', conceptIds: ['cpt-automatic-cookie-sending']}])
    assert.deepEqual(result.mergeDeletes, [])
  })

  it('ignores a stale proposal and skips one overlapping an applied merge', () => {
    const stale = merge({proposalId: 'concept-merge-0', canonicalCandidateIds: ['cand-gone']})
    const overlapping = merge({
      proposalId: 'concept-merge-2',
      members: [
        {conceptId: 'cpt-csrf-risk-with-cookies', candidateIds: [csrfRisk._key]},
        {conceptId: 'cpt-xss', candidateIds: [xss._key]},
      ],
    })
    const result = plan(spans, [], [stale, merge(), overlapping])
    assert.deepEqual(result.merges.stale, ['concept-merge-0'])
    assert.deepEqual(result.merges.overlapping, ['concept-merge-2'])
    assert.equal(result.drafts.length, 2)
  })

  describe('rejecting a merge preserves every original concept', () => {
    const originals = plan(spans).drafts
    const ids = originals.map((draft) => draft.conceptId)

    it('leaves the plan identical when the rejected proposal was never applied', () => {
      const existing = originals.map((draft) => existingFrom(draft))
      const withRejection = plan(spans, existing, [], [merge()])
      assert.deepEqual(withRejection, plan(spans, existing))
      assert.deepEqual(withRejection.unchanged, ids)
      assert.deepEqual(withRejection.drafts, [])
      assert.deepEqual(withRejection.mergeDeletes, [])
    })

    it('restores every member of an applied proposal under its own id when it is rejected', () => {
      // Accept → apply: the member draft is deleted and its name becomes an alias of the canonical.
      const applied = plan(spans, originals.map((draft) => existingFrom(draft)), [merge()])
      assert.deepEqual(applied.mergeDeletes, ['drafts.concept-cpt-automatic-cookie-sending'])
      const afterApply = [
        ...applied.drafts.map((draft) => existingFrom(draft)),
        ...originals.filter((draft) => !applied.drafts.some((other) => other.conceptId === draft.conceptId) && draft.conceptId !== 'cpt-automatic-cookie-sending').map((draft) => existingFrom(draft)),
      ]
      assert.deepEqual(afterApply.map((doc) => doc.conceptId).toSorted(), ['cpt-csrf-risk-with-cookies', 'cpt-xss'])

      // Reject → re-project: the member comes back with its original id and content; the canonical loses the merge.
      const reverted = plan(spans, afterApply, [], [merge()])
      assert.deepEqual(reverted.conflicts, [])
      assert.deepEqual(reverted.mergeDeletes, [])
      assert.deepEqual(reverted.merges.restored, [{proposalId: 'concept-merge-1', conceptId: 'cpt-automatic-cookie-sending'}])
      const restored = new Map(reverted.drafts.map((draft) => [draft.conceptId, draft]))
      // Same content and generation fields as before the merge (both runs share `NOW`).
      for (const original of originals.filter((draft) => draft.conceptId !== 'cpt-xss')) {
        assert.deepEqual(restored.get(original.conceptId), original, original.conceptId)
      }
      assert.deepEqual([...restored.keys(), ...reverted.unchanged].toSorted(), ids.toSorted())
    })

    it('writes nothing for a concept id two projections resolve to', () => {
      // Without the rejected proposal, the member cluster matches the canonical through the merged alias.
      const applied = plan(spans, originals.map((draft) => existingFrom(draft)), [merge()])
      const afterApply = [
        ...applied.drafts.map((draft) => existingFrom(draft)),
        existingFrom(originals.find((draft) => draft.conceptId === 'cpt-xss')!),
      ]
      const unguarded = plan(spans, afterApply)
      assert.deepEqual(unguarded.drafts.map((draft) => draft.conceptId), [])
      assert.deepEqual(unguarded.unchanged, ['cpt-xss'])
      assert.deepEqual(unguarded.conflicts.map((conflict) => conflict.conceptIds), [['cpt-csrf-risk-with-cookies'], ['cpt-csrf-risk-with-cookies']])
      assert.deepEqual(unguarded.unreproduced, [])
    })
  })
})

describe('projected aliases', () => {
  it('drops component identifiers and narrower member names, keeping synonyms and abbreviations', () => {
    const spans = [
      span('lesson-a', 0, 0, [candidate('Content Security Policy', 'lesson-a', [0, 30], {aliases: ['CSP']})]),
      span('lesson-a', 0, 1, [
        candidate('Content Security Policy script-src', 'lesson-a', [60], {aliases: ['CSP', 'script-src']}),
      ]),
    ]
    const [draft] = plan(spans).drafts
    assert.equal(draft.name, 'Content Security Policy')
    assert.deepEqual(draft.aliases, ['CSP'])
    assert.equal(draft.generation.candidateIds.length, 2, 'the directive stays part of the concept evidence')
  })
})
