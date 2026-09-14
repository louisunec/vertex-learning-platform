import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {assessmentDocumentId, sectionFamilyIds, transferFamilyId, type ExistingVersion, type GeneratedItem} from '../assessments/generate.ts'
import {processLesson, type GenerateFn, type LessonVideo, type Mutation} from '../assessments/pipeline.ts'
import {assertDraftOnlyWrites, executeCandidate, planRegeneration, UnsafeRegenerationWrite, unitOfFamily, type RegenerationInputs} from './regenerate.ts'

/**
 * Signal-driven draft regeneration (development plan §5 PR-10): it reuses
 * the PR-1 generator for the flagged unit only, and can never write a
 * published version, replace an editor's draft, or publish anything.
 */

const LESSON = {_id: 'lesson-hooks', title: 'Hooks'}
const [FAM0, FAM1] = sectionFamilyIds(LESSON._id, 0)
const published = (familyId: string, version: number, spanKey = 'old-span-key'): ExistingVersion => ({
  _id: assessmentDocumentId(familyId, version),
  familyId,
  version,
  spanKey,
  // Revisions that no longer match the video: a normal generator run would mark these stale.
  sourceChunkRefs: [{chunkId: 'tc-20-1', chunkRevision: 'rev-before-edit'}],
})

const video: LessonVideo = {
  _id: 'video-youtube-dQw4w9WgXcQ',
  durationSeconds: 400,
  chapters: null,
  transcriptChunks: Array.from({length: 20}, (_, i) => ({_key: `tc-${i * 20}-${i}`, startSeconds: i * 20, text: `chunk ${i}`})),
}

const item = (type: GeneratedItem['type']): GeneratedItem => ({
  objective: 'Choose the hook that stores state.',
  type,
  question: 'Which hook keeps a counter value between renders?',
  options: [
    {text: 'useState', correct: true, reason: 'It keeps render state and re-renders on change.'},
    {text: 'useEffect', correct: false, reason: 'It runs side effects and holds no value.'},
    {text: 'useMemo', correct: false, reason: 'It caches a computed result only.'},
  ],
  hints: {direction: 'Which hook re-renders on change?', keyConcept: 'Rendering state lives in React state.', solution: 'useState.'},
  sourceChunks: [1],
})

function io(existing: ExistingVersion[]) {
  const committed: Mutation[][] = []
  let calls = 0
  const generate: GenerateFn = async () => {
    calls++
    return {items: [item('apply'), item('recall')], skipReason: null}
  }
  const inputs: RegenerationInputs = {lesson: LESSON, video, existing, recordedKeys: ['old-span-key']}
  return {
    committed,
    calls: () => calls,
    io: {model: 'gpt-5-mini', generate, loadInputs: async () => inputs, commit: async (transaction: Mutation[]) => void committed.push(transaction)},
  }
}

const candidate = {lessonId: LESSON._id, familyId: FAM0, assessmentVersion: 1}

describe('signal-driven regeneration', () => {
  it('maps a family id to its generator unit', () => {
    assert.deepEqual(unitOfFamily(FAM1), {kind: 'section', spanIndex: 0})
    assert.deepEqual(unitOfFamily(transferFamilyId(LESSON._id)), {kind: 'lesson_transfer', spanIndex: null})
    assert.equal(unitOfFamily('fam1'), null)
  })

  it('drafts new versions of the flagged unit only, pending review, without touching published ones', async () => {
    const existing = [published(FAM0, 1), published(FAM1, 1), published(sectionFamilyIds(LESSON._id, 1)[0], 1)]
    const before = structuredClone(existing)
    const harness = io(existing)
    const outcome = await executeCandidate(candidate, harness.io)

    assert.equal(outcome.status, 'drafted')
    assert.deepEqual(outcome.draftIds.toSorted(), [`drafts.${assessmentDocumentId(FAM0, 2)}`, `drafts.${assessmentDocumentId(FAM1, 2)}`])
    assert.equal(harness.calls(), 1, 'one model call: only section 0, no transfer, no other section')
    const mutations = harness.committed.flat()
    for (const mutation of mutations) {
      assert.ok('createOrReplace' in mutation, 'no delete and no patch (not even staleness marks)')
      const doc = mutation.createOrReplace as {_id: string; _type: string; reviewStatus?: string}
      if (doc._type === 'assessment') {
        assert.match(doc._id, /^drafts\./)
        assert.equal(doc.reviewStatus, 'needs_review')
      } else {
        assert.equal(doc._type, 'assessmentGenerationRecord')
      }
    }
    assert.equal(mutations.some((mutation) => 'createOrReplace' in mutation && existing.some((doc) => doc._id === mutation.createOrReplace._id)), false)
    assert.deepEqual(existing, before)

    // Control: a normal generator run over the same inputs would have patched the published versions stale.
    const normal = await processLesson({lesson: LESSON, video, existing, processedSpanKeys: new Set(), force: false, model: 'gpt-5-mini', generate: harness.io.generate, budget: {remaining: 0}})
    assert.ok(normal.staleIds.length > 0)
  })

  it('never replaces a draft an editor may be reviewing', async () => {
    const harness = io([published(FAM0, 1), published(FAM1, 1), {_id: `drafts.${assessmentDocumentId(FAM1, 2)}`, familyId: FAM1, version: 2}])
    const outcome = await executeCandidate(candidate, harness.io)
    assert.deepEqual([outcome.status, outcome.reason], ['skipped', 'draft_pending_review'])
    assert.equal(harness.calls(), 0)
    assert.equal(harness.committed.length, 0)
  })

  it('skips when a newer version already exists or the flagged version is gone', () => {
    assert.deepEqual(planRegeneration(candidate, [published(FAM0, 1), published(FAM0, 2), published(FAM1, 1)]), {action: 'skip', reason: 'newer_version_exists'})
    assert.deepEqual(planRegeneration(candidate, [published(FAM1, 1)]), {action: 'skip', reason: 'flagged_version_missing'})
    assert.deepEqual(planRegeneration({...candidate, familyId: 'fam1'}, []), {action: 'skip', reason: 'unknown_unit'})
  })

  it('refuses any write that is not a new draft of the unit pending review', () => {
    const existing = [published(FAM0, 1)]
    const scope = {existing, familyIds: [FAM0, FAM1]}
    const draft = (overrides: Record<string, unknown>) => [[{createOrReplace: {_id: `drafts.${assessmentDocumentId(FAM0, 2)}`, _type: 'assessment', familyId: FAM0, version: 2, reviewStatus: 'needs_review', ...overrides}}]] as unknown as Mutation[][]
    assert.doesNotThrow(() => assertDraftOnlyWrites(draft({}), scope))
    assert.throws(() => assertDraftOnlyWrites(draft({_id: assessmentDocumentId(FAM0, 2)}), scope), UnsafeRegenerationWrite)
    assert.throws(() => assertDraftOnlyWrites(draft({version: 1, _id: `drafts.${assessmentDocumentId(FAM0, 1)}`}), scope), UnsafeRegenerationWrite)
    assert.throws(() => assertDraftOnlyWrites(draft({reviewStatus: 'approved'}), scope), UnsafeRegenerationWrite)
    assert.throws(() => assertDraftOnlyWrites(draft({familyId: 'asm-00000000-s9-q0'}), scope), UnsafeRegenerationWrite)
    assert.throws(() => assertDraftOnlyWrites([[{delete: {id: `drafts.${assessmentDocumentId(FAM0, 2)}`}}]], scope), UnsafeRegenerationWrite)
    assert.throws(() => assertDraftOnlyWrites([[{patch: {id: assessmentDocumentId(FAM0, 1), set: {sourceStatus: 'stale'}}}]], scope), UnsafeRegenerationWrite)
  })
})
