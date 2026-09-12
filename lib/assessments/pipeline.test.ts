import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {
  TRANSFER_SYSTEM_PROMPT,
  transferFamilyId,
  transferOutputSchema,
  type AssessmentDraft,
  type ExistingVersion,
  type GeneratedItem,
} from './generate.ts'
import {
  generationRecordId,
  processLesson,
  type GenerateFn,
  type GenerationKind,
  type GenerationOutput,
  type LessonResult,
  type LessonVideo,
} from './pipeline.ts'

const LESSON = {_id: 'lesson-hooks', title: 'Hooks'}
const MODEL = 'gpt-5-mini'
const NOW = () => new Date('2026-09-12T00:00:00Z')

/** 20 chunks, no chapters → two 10-chunk sections; the transfer unit reads section 0 (tie → nearest the middle, first wins). */
const video = (editedText?: string): LessonVideo => ({
  _id: 'video-youtube-dQw4w9WgXcQ',
  durationSeconds: 400,
  chapters: null,
  transcriptChunks: Array.from({length: 20}, (_, i) => ({
    _key: `tc-${i * 20}-${i}`,
    startSeconds: i * 20,
    text: i === 0 && editedText ? editedText : `chunk ${i}`,
  })),
})

const validItem = (overrides: Partial<GeneratedItem> = {}): GeneratedItem => ({
  objective: 'Choose the hook that stores state.',
  type: 'apply',
  question: 'Which hook keeps a counter value between renders?',
  options: [
    {text: 'useState', correct: true, reason: 'It keeps render state and re-renders on change.'},
    {text: 'useEffect', correct: false, reason: 'It runs side effects and holds no value.'},
    {text: 'useMemo', correct: false, reason: 'It caches a computed result only.'},
    {text: 'useLayoutEffect', correct: false, reason: 'It runs effects before paint and holds no value.'},
  ],
  hints: {direction: 'Which hook re-renders on change?', keyConcept: 'Rendering state lives in React state.', solution: 'useState.'},
  sourceChunks: [1],
  ...overrides,
})

const EMPTY: GenerationOutput = {items: [], skipReason: 'channel intro'}
const REJECTED: GenerationOutput = {items: [validItem({sourceChunks: [99]})], skipReason: null}
const DRAFTED: GenerationOutput = {items: [validItem()], skipReason: null}
const DRAFTED_TWO: GenerationOutput = {items: [validItem(), validItem({type: 'recall'})], skipReason: null}
const TRANSFER: GenerationOutput = {
  items: [validItem({type: 'transfer', question: 'A shopping cart must keep its item count between renders. Which hook fits?'})],
  skipReason: null,
}
const NO_TRANSFER: GenerationOutput = {items: [], skipReason: 'no principle carries over'}

type Reply = GenerationOutput | Error
type FakeModel = GenerateFn & {calls: Record<GenerationKind, number>; inputs: Array<Parameters<GenerateFn>[0]>}

/** A `generate` answering section and transfer calls separately, counting calls per kind. */
function fakeModel(section: Reply, transfer: Reply = NO_TRANSFER): FakeModel {
  const generate: GenerateFn = async (input) => {
    fn.calls[input.kind]++
    fn.inputs.push(input)
    const reply = input.kind === 'section' ? section : transfer
    if (reply instanceof Error) throw reply
    return reply
  }
  const fn = Object.assign(generate, {
    calls: {section: 0, lesson_transfer: 0},
    inputs: [] as Array<Parameters<GenerateFn>[0]>,
  })
  return fn
}

async function run(options: {
  generate: GenerateFn
  processed?: string[]
  existing?: ExistingVersion[]
  force?: boolean
  budget?: number
  editedText?: string
  lesson?: {_id: string; title: string}
  video?: LessonVideo | null
}): Promise<LessonResult> {
  return processLesson({
    lesson: options.lesson ?? LESSON,
    video: options.video === undefined ? video(options.editedText) : options.video,
    existing: options.existing ?? [],
    processedSpanKeys: new Set(options.processed ?? []),
    force: options.force ?? false,
    model: MODEL,
    generate: options.generate,
    budget: {remaining: options.budget ?? 100},
    now: NOW,
  })
}

const keysOf = (result: LessonResult) => result.records.map((record) => record.spanKey)
const asExisting = (drafts: AssessmentDraft[], options: {published?: boolean} = {}): ExistingVersion[] =>
  drafts.map((draft) => ({
    _id: options.published ? draft._id.replace(/^drafts\./, '') : draft._id,
    familyId: draft.familyId,
    version: draft.version,
    spanKey: draft.generation.spanKey,
    sourceStatus: 'current',
    sourceChunkRefs: draft.sourceChunkRefs,
  }))
const written = (result: LessonResult) =>
  result.transactions.flat().flatMap((mutation) =>
    'createOrReplace' in mutation && mutation.createOrReplace._type === 'assessment' ? [mutation.createOrReplace._id] : [],
  )
const deletes = (result: LessonResult) =>
  result.transactions.flat().flatMap((mutation) => ('delete' in mutation ? [mutation.delete.id] : []))

describe('processLesson idempotency', () => {
  it('records a no_candidates outcome, and a rerun makes no model call for it', async () => {
    const first = fakeModel(EMPTY)
    const firstRun = await run({generate: first})
    assert.deepEqual(first.calls, {section: 2, lesson_transfer: 1})
    assert.deepEqual(
      firstRun.records.map((record) => [record.kind, record.outcome, record.modelSkipReason, record.draftIds]),
      [
        ['section', 'no_candidates', 'channel intro', []],
        ['section', 'no_candidates', 'channel intro', []],
        ['lesson_transfer', 'no_candidates', 'no principle carries over', []],
      ],
    )

    const rerun = fakeModel(DRAFTED, TRANSFER)
    const second = await run({generate: rerun, processed: keysOf(firstRun)})
    assert.deepEqual(rerun.calls, {section: 0, lesson_transfer: 0})
    assert.deepEqual(
      second.sections.map((section) => section.status),
      ['skipped', 'skipped', 'skipped'],
    )
    assert.deepEqual(second.transactions, [])
  })

  it('records an all_rejected outcome with reasons, and a rerun makes no model call for it', async () => {
    const firstRun = await run({generate: fakeModel(REJECTED, REJECTED)})
    assert.deepEqual(
      firstRun.records.map((record) => [record.outcome, record.rejectionReasons]),
      [
        ['all_rejected', ['source_out_of_span']],
        ['all_rejected', ['source_out_of_span']],
        ['all_rejected', ['source_out_of_span']],
      ],
    )
    const rerun = fakeModel(DRAFTED, TRANSFER)
    await run({generate: rerun, processed: keysOf(firstRun)})
    assert.deepEqual(rerun.calls, {section: 0, lesson_transfer: 0})
  })

  it('reprocesses recorded units only with --force', async () => {
    const firstRun = await run({generate: fakeModel(EMPTY)})
    const forced = fakeModel(DRAFTED, TRANSFER)
    const result = await run({generate: forced, processed: keysOf(firstRun), force: true})
    assert.deepEqual(forced.calls, {section: 2, lesson_transfer: 1})
    assert.deepEqual(
      result.records.map((record) => record.outcome),
      ['drafted', 'drafted', 'drafted'],
    )
  })

  it('writes no record for a provider failure, so the next run retries it', async () => {
    const failing = fakeModel(Object.assign(new Error('timeout'), {category: 'timeout'}), new Error('network'))
    const result = await run({generate: failing})
    assert.deepEqual(failing.calls, {section: 2, lesson_transfer: 1})
    assert.deepEqual(result.records, [])
    assert.deepEqual(result.transactions, [])
    assert.match(result.sections[0].detail, /timeout.*retried next run/)

    const retry = fakeModel(EMPTY)
    await run({generate: retry, processed: keysOf(result)})
    assert.deepEqual(retry.calls, {section: 2, lesson_transfer: 1})
  })

  it('processes a unit again when its source changed, even if recorded', async () => {
    const firstRun = await run({generate: fakeModel(EMPTY)})
    const rerun = fakeModel(EMPTY)
    await run({generate: rerun, processed: keysOf(firstRun), editedText: 'edited caption'})
    // Only section 0 contains the edited chunk, and the transfer unit reads section 0.
    assert.deepEqual(rerun.calls, {section: 1, lesson_transfer: 1})
  })

  it('defers units past the run cap without recording them', async () => {
    const generate = fakeModel(EMPTY)
    const result = await run({generate, budget: 1})
    assert.deepEqual(generate.calls, {section: 1, lesson_transfer: 0})
    assert.deepEqual(
      result.sections.map((section) => section.status),
      ['no_candidates', 'deferred', 'deferred'],
    )
    assert.equal(result.records.length, 1)
  })
})

describe('processLesson transfer coverage', () => {
  it('drafts the lesson transfer item from one bounded section with the transfer prompt and schema', async () => {
    const generate = fakeModel(EMPTY, TRANSFER)
    const result = await run({generate})
    const transferCall = generate.inputs.find((input) => input.kind === 'lesson_transfer')!
    assert.equal(transferCall.system, TRANSFER_SYSTEM_PROMPT)
    assert.equal(transferCall.schema, transferOutputSchema)
    assert.equal(transferCall.prompt.match(/^c\d+ /gm)?.length, 10)

    const record = result.records.find((entry) => entry.kind === 'lesson_transfer')!
    assert.equal(record.outcome, 'drafted')
    assert.equal(record.spanIndex, 0)
    const [draft] = result.drafts
    assert.equal(draft.type, 'transfer')
    assert.equal(draft.familyId, transferFamilyId(LESSON._id))
    assert.deepEqual(record.draftIds, [draft._id])
  })

  it('every lesson with a transcript ends with a transfer draft or an explicit lesson_transfer record', async () => {
    const replies: Record<string, GenerationOutput> = {
      'lesson-drafted': TRANSFER,
      'lesson-empty': NO_TRANSFER,
      'lesson-rejected': {
        items: [
          validItem({
            type: 'transfer',
            options: validItem().options.map((option, i) => (i === 0 ? {...option, reason: 'Option 1 is correct.'} : option)),
          }),
        ],
        skipReason: null,
      },
    }
    for (const [lessonId, reply] of Object.entries(replies)) {
      const result = await run({generate: fakeModel(DRAFTED, reply), lesson: {_id: lessonId, title: lessonId}})
      const transferRecords = result.records.filter((record) => record.kind === 'lesson_transfer')
      assert.equal(transferRecords.length, 1, lessonId)
      const [record] = transferRecords
      const transferDrafts = result.drafts.filter((draft) => draft.type === 'transfer')
      if (record.outcome === 'drafted') assert.equal(transferDrafts.length, 1, lessonId)
      else assert.equal(transferDrafts.length, 0, lessonId)
      assert.equal(
        {drafted: 'lesson-drafted', no_candidates: 'lesson-empty', all_rejected: 'lesson-rejected'}[record.outcome],
        lessonId,
      )
      if (record.outcome === 'all_rejected') assert.deepEqual(record.rejectionReasons, ['positional_reference:option 1'])
    }
  })

  it('does not call the model again for a recorded transfer outcome', async () => {
    const firstRun = await run({generate: fakeModel(EMPTY, NO_TRANSFER)})
    const rerun = fakeModel(EMPTY, TRANSFER)
    await run({generate: rerun, processed: keysOf(firstRun)})
    assert.equal(rerun.calls.lesson_transfer, 0)
  })

  it('shortens an over-long model skip reason visibly instead of cutting it silently', async () => {
    const result = await run({generate: fakeModel({items: [], skipReason: `${'x'.repeat(250)}.`})})
    const reason = result.records[0].modelSkipReason!
    assert.equal(reason.length, 200)
    assert.ok(reason.endsWith('…'))
  })

  it('makes no transfer call for a lesson without transcript chunks', async () => {
    const generate = fakeModel(DRAFTED, TRANSFER)
    const result = await run({generate, video: null})
    assert.deepEqual(generate.calls, {section: 0, lesson_transfer: 0})
    assert.equal(result.skipReason, 'no ingested transcript chunks')
  })
})

describe('processLesson regeneration', () => {
  it('--force replaces unpublished drafts in place: same ids, no new version', async () => {
    const firstRun = await run({generate: fakeModel(DRAFTED, TRANSFER)})
    const result = await run({
      generate: fakeModel(DRAFTED, TRANSFER),
      existing: asExisting(firstRun.drafts),
      processed: keysOf(firstRun),
      force: true,
    })
    const ids = firstRun.drafts.map((draft) => draft._id).toSorted()
    assert.deepEqual(written(result).toSorted(), ids)
    assert.deepEqual(result.replacedIds.toSorted(), ids)
    assert.ok(result.drafts.every((draft) => draft.version === 1))
    assert.deepEqual(deletes(result), [])
  })

  it('--force over a published version drafts the next version and never writes the published one', async () => {
    const firstRun = await run({generate: fakeModel(DRAFTED, TRANSFER)})
    const published = asExisting(firstRun.drafts, {published: true})
    const result = await run({generate: fakeModel(DRAFTED, TRANSFER), existing: published, force: true})
    assert.ok(result.drafts.every((draft) => draft.version === 2 && draft._id.startsWith('drafts.')))
    const touched = result.transactions.flat().map((mutation) =>
      'createOrReplace' in mutation ? mutation.createOrReplace._id : 'delete' in mutation ? mutation.delete.id : mutation.patch.id,
    )
    for (const doc of published) assert.ok(!touched.includes(doc._id), doc._id)
    assert.deepEqual(result.replacedIds, [])
  })

  it('--force deletes an unpublished draft the new output no longer produces', async () => {
    const firstRun = await run({generate: fakeModel(DRAFTED_TWO, TRANSFER)})
    assert.equal(firstRun.drafts.length, 5)
    const result = await run({
      generate: fakeModel(DRAFTED, NO_TRANSFER),
      existing: asExisting(firstRun.drafts),
      processed: keysOf(firstRun),
      force: true,
    })
    const expectedDeleted = firstRun.drafts
      .filter((draft) => draft.generation.ordinal === 1 || draft.type === 'transfer')
      .map((draft) => draft._id)
      .toSorted()
    assert.deepEqual(deletes(result).toSorted(), expectedDeleted)
    assert.deepEqual(result.deletedIds.toSorted(), expectedDeleted)
  })

  it('--force never deletes a published version the new output no longer produces', async () => {
    const firstRun = await run({generate: fakeModel(DRAFTED_TWO, TRANSFER)})
    const result = await run({
      generate: fakeModel(DRAFTED, NO_TRANSFER),
      existing: asExisting(firstRun.drafts, {published: true}),
      force: true,
    })
    assert.deepEqual(deletes(result), [])
  })

  it('a source change replaces the unpublished draft in place and deletes nothing without --force', async () => {
    const firstRun = await run({generate: fakeModel(DRAFTED_TWO, TRANSFER)})
    const result = await run({
      generate: fakeModel(DRAFTED, NO_TRANSFER),
      existing: asExisting(firstRun.drafts),
      processed: keysOf(firstRun),
      editedText: 'edited caption',
    })
    const section0 = firstRun.drafts.find((draft) => draft.generation.spanIndex === 0 && draft.generation.ordinal === 0)!
    assert.deepEqual(written(result), [section0._id])
    assert.deepEqual(deletes(result), [])
  })
})

describe('processLesson writes', () => {
  it('commits drafts and their record in one transaction; records are never assessments or drafts', async () => {
    const result = await run({generate: fakeModel(DRAFTED, TRANSFER)})
    assert.equal(result.transactions.length, 3)
    for (const transaction of result.transactions) {
      const docs = transaction.flatMap((mutation) => ('createOrReplace' in mutation ? [mutation.createOrReplace] : []))
      const drafts = docs.filter((doc) => doc._type === 'assessment')
      const records = docs.filter((doc) => doc._type === 'assessmentGenerationRecord')
      assert.equal(drafts.length, 1)
      assert.equal(records.length, 1)
      const record = records[0] as {_id: string; draftIds: string[]}
      assert.ok(!record._id.startsWith('drafts.'))
      assert.deepEqual(record.draftIds, [drafts[0]._id])
    }
    assert.equal(result.records[0]._id, generationRecordId(result.records[0].spanKey))
  })

  it('marks changed versions stale in a leading transaction', async () => {
    const firstRun = await run({generate: fakeModel(DRAFTED)})
    const existing = asExisting(firstRun.drafts)
    const result = await run({
      generate: fakeModel(EMPTY),
      existing,
      processed: keysOf(firstRun),
      editedText: 'edited caption',
    })
    // Chunk 0 changed, but each draft cites its section's second chunk, so none is stale.
    assert.deepEqual(result.staleIds, [])

    const citing0 = existing.map((doc) => ({...doc, sourceChunkRefs: [{...doc.sourceChunkRefs![0], chunkRevision: 'old'}]}))
    const staleRun = await run({generate: fakeModel(EMPTY), existing: citing0, processed: keysOf(firstRun)})
    assert.deepEqual(staleRun.staleIds, existing.map((doc) => doc._id))
    assert.deepEqual(staleRun.transactions[0], existing.map((doc) => ({patch: {id: doc._id, set: {sourceStatus: 'stale'}}})))
  })
})
