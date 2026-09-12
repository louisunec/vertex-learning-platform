import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import type {LessonVideo} from '../assessments/pipeline.ts'
import type {ExistingConcept} from './cluster.ts'
import {MAX_CONSOLIDATION_CONCEPTS, type ConsolidationConcept, type ConsolidationOutput} from './consolidate.ts'
import type {ExtractionOutput, GeneratedConcept} from './extract.ts'
import {
  extractCourse,
  findStaleInScope,
  proposeMerges,
  proposePrerequisites,
  videoIdOfChunk,
  type ConceptGenerateFn,
  type CourseLesson,
  type ExtractionRecord,
} from './pipeline.ts'
import {MAX_PREREQUISITE_CONCEPTS, type EdgeConcept, type PrerequisiteOutput} from './prerequisites.ts'
import {toSourceChunks} from '../evidence/chunks.ts'

const COURSE = {_id: 'course-web', title: 'Web security'}
const MODEL = 'gpt-5-mini'
const NOW = () => new Date('2026-09-12T00:00:00Z')

/** 20 chunks, no chapters → two 10-chunk spans. */
const video = (id: string, editedText?: string): LessonVideo => ({
  _id: id,
  durationSeconds: 600,
  chapters: null,
  transcriptChunks: Array.from({length: 20}, (_, i) => ({
    _key: `tc-${i}`,
    startSeconds: i * 30,
    text: i === 0 && editedText ? editedText : `chunk ${i}`,
  })),
})

const lessons = (overrides: Partial<Record<'a' | 'b', Partial<CourseLesson>>> = {}): CourseLesson[] => [
  {lesson: {_id: 'lesson-a', title: 'Cookies'}, order: 0, video: video('video-a'), inScope: true, ...overrides.a},
  {lesson: {_id: 'lesson-b', title: 'CSRF'}, order: 1, video: video('video-b'), inScope: true, ...overrides.b},
]

const concept = (name: string): GeneratedConcept => ({
  name,
  aliases: [],
  summary: `${name} is defined here.`,
  objectives: [`Explain ${name}.`],
  sourceChunks: [0],
})

type Reply = ExtractionOutput | PrerequisiteOutput | ConsolidationOutput | Error

const only = (primary: GeneratedConcept | null, extra: Partial<ExtractionOutput> = {}): ExtractionOutput => ({
  primary,
  secondary: null,
  excludedDetails: [],
  skipReason: primary ? null : 'intro',
  ...extra,
})
type FakeModel = ConceptGenerateFn & {calls: number; prompts: string[]}

/** Answers every call with `reply(callNumber)`, counting calls. */
function fakeModel(reply: (call: number) => Reply): FakeModel {
  const generate = (async (input: {prompt: string}) => {
    fn.prompts.push(input.prompt)
    const answer = reply(fn.calls++)
    if (answer instanceof Error) throw answer
    return answer
  }) as ConceptGenerateFn
  const fn = Object.assign(generate, {calls: 0, prompts: [] as string[]})
  return fn
}

/** Each span proposes one concept named after its call number, except call 1, which proposes a synonym of call 0. */
const perSpan = fakeModel
const conceptsBySpan = (call: number): ExtractionOutput => only(concept(call === 1 ? 'Cookie 0' : `Cookie ${call}`))

const run = (input: Partial<Parameters<typeof extractCourse>[0]> & {generate: ConceptGenerateFn}) =>
  extractCourse({
    course: COURSE,
    lessons: lessons(),
    recorded: new Map(),
    existingConcepts: [],
    existingEdges: [],
    force: false,
    model: MODEL,
    budget: {remaining: 100},
    now: NOW,
    ...input,
  })

const recordedFrom = (records: ExtractionRecord[]) => new Map(records.map((record) => [record.key, record]))

describe('extractCourse', () => {
  it('calls the model once per span and projects the recorded candidates into drafts', async () => {
    const model = perSpan(conceptsBySpan)
    const result = await run({generate: model})
    assert.equal(model.calls, 4)
    assert.equal(result.records.length, 4)
    assert.ok(result.records.every((record) => record.outcome === 'extracted' && record._id.startsWith('concept-generation-')))
    // Calls 0 and 1 name the same concept, so four candidates make three drafts.
    assert.equal(result.plan.clusters, 3)
    assert.deepEqual(
      result.plan.drafts.map((draft) => draft.conceptId),
      ['cpt-cookie-0', 'cpt-cookie-2', 'cpt-cookie-3'],
    )
    assert.ok(result.plan.drafts.every((draft) => draft._id.startsWith('drafts.concept-')))
    assert.ok(model.prompts.every((prompt) => (prompt.match(/^c\d+ /gm) ?? []).length <= 12))
    // One transaction per record, then the drafts together.
    assert.equal(result.transactions.length, 5)
    assert.equal(result.transactions.at(-1)?.length, 3)
  })

  it('makes no model call and writes nothing on an unchanged rerun', async () => {
    const first = await run({generate: perSpan(conceptsBySpan)})
    const existing: ExistingConcept[] = first.plan.drafts.map((draft) => ({
      ...draft,
      reviewStatus: draft.reviewStatus,
      generationCourse: COURSE._id,
      contentHash: draft.generation.contentHash,
    }))
    const model = perSpan(() => new Error('must not be called'))
    const again = await run({generate: model, recorded: recordedFrom(first.records), existingConcepts: existing})
    assert.equal(model.calls, 0)
    assert.deepEqual(again.transactions, [])
    assert.equal(again.plan.unchanged.length, 3)
    assert.ok(again.spans.every((span) => span.status === 'skipped'))
  })

  it('leaves no record for a failed call and retries it next run', async () => {
    const error = Object.assign(new Error('boom'), {category: 'timeout'})
    const result = await run({generate: perSpan((call) => (call === 0 ? error : conceptsBySpan(call)))})
    assert.equal(result.records.length, 3)
    assert.match(result.spans[0].detail, /model call failed \(timeout\)/)
    const retry = perSpan(conceptsBySpan)
    await run({generate: retry, recorded: recordedFrom(result.records)})
    assert.equal(retry.calls, 1)
  })

  it('defers spans past the run cap without recording them', async () => {
    const result = await run({generate: perSpan(conceptsBySpan), budget: {remaining: 1}})
    assert.equal(result.modelCalls, 1)
    assert.deepEqual(
      result.spans.map((span) => span.status),
      ['extracted', 'deferred', 'deferred', 'deferred'],
    )
  })

  it('calls the model only for in-scope lessons but projects every recorded span', async () => {
    const first = await run({generate: perSpan(conceptsBySpan)})
    const model = perSpan(conceptsBySpan)
    const result = await run({
      generate: model,
      recorded: recordedFrom(first.records.filter((record) => record.lesson._ref === 'lesson-b')),
      lessons: lessons({b: {inScope: false}}),
    })
    assert.equal(model.calls, 2)
    assert.equal(result.plan.drafts.length, 3)
  })

  it('records zero-candidate and all-rejected spans so reruns skip them', async () => {
    const result = await run({
      generate: perSpan((call) => (call % 2 === 0 ? only(null) : only({...concept('Bad'), sourceChunks: [99]}))),
    })
    assert.deepEqual(
      result.records.map((record) => record.outcome),
      ['no_candidates', 'all_rejected', 'no_candidates', 'all_rejected'],
    )
    assert.deepEqual(result.plan.drafts, [])
  })

  it('rejects a secondary that repeats the primary or has no primary, keeping audit copies', async () => {
    const secondary = (name: string) => ({...concept(name), independenceReason: 'Assessable on its own.'})
    const result = await run({
      generate: perSpan((call) =>
        call === 0 ? only(concept('XSS'), {secondary: secondary('xss')}) : only(null, {secondary: secondary('CSP'), skipReason: null}),
      ),
      budget: {remaining: 2},
    })
    assert.deepEqual(result.records[0].rejectionReasons, ['secondary_duplicates_primary'])
    assert.deepEqual(result.records[1].rejectionReasons, ['secondary_without_primary'])
    assert.deepEqual(
      result.records.map((record) => record.rejectedCandidates.map((entry) => [entry.name, entry.role])),
      [[['xss', 'secondary']], [['CSP', 'secondary']]],
    )
    assert.equal(result.records[1].outcome, 'all_rejected')
  })

  it('records primary and independent secondary candidates, excluded details, and dropped aliases', async () => {
    const result = await run({
      generate: perSpan(() =>
        only({...concept('CSRF'), aliases: ['CSRF vs CORS']}, {
          secondary: {...concept('SameSite cookies'), independenceReason: 'Assessable on its own.'},
          excludedDetails: ['the admin username', 'curl output'],
        }),
      ),
      budget: {remaining: 1},
    })
    const [record] = result.records
    assert.deepEqual(record.candidates.map((candidate) => candidate.role), ['primary', 'secondary'])
    assert.deepEqual(record.excludedDetails, ['the admin username', 'curl output'])
    assert.equal(record.droppedAliases, 1)
    assert.equal(result.currentSpans.length, 1)
  })

  it('applies an accepted merge by candidate id and deletes the absorbed unedited draft', async () => {
    const first = await run({generate: perSpan(conceptsBySpan)})
    const existing: ExistingConcept[] = first.plan.drafts.map((draft) => ({
      ...draft,
      generationCourse: COURSE._id,
      contentHash: draft.generation.contentHash,
    }))
    const [canonical, absorbed] = first.plan.drafts
    const result = await run({
      generate: perSpan(() => new Error('must not be called')),
      recorded: recordedFrom(first.records),
      existingConcepts: existing,
      acceptedMerges: [
        {
          proposalId: 'concept-merge-x',
          canonicalCandidateIds: canonical.generation.candidateIds,
          members: [canonical, absorbed].map((draft) => ({conceptId: draft.conceptId, candidateIds: draft.generation.candidateIds})),
        },
      ],
    })
    assert.deepEqual(result.plan.mergeDeletes, [absorbed._id])
    assert.ok(result.transactions.at(-1)?.some((mutation) => 'delete' in mutation && mutation.delete.id === absorbed._id))
    assert.equal(result.plan.drafts.find((draft) => draft.conceptId === canonical.conceptId)?.generation.appliedMerges?.[0], 'concept-merge-x')
  })

  it('marks concepts and edges stale when a cited chunk in the run changes, and ignores other videos', async () => {
    const [chunk0] = toSourceChunks(video('video-a'))
    const cite = (chunkId: string, chunkRevision: string) => [{chunkId, chunkRevision}]
    const existingConcepts = [
      {_id: 'concept-cpt-a', conceptId: 'cpt-a', name: 'A', aliases: [], summary: 'A.', objectives: [], lessons: [], reviewStatus: 'approved', sourceRefs: cite(chunk0.chunkId, chunk0.chunkRevision)},
      {_id: 'concept-cpt-elsewhere', conceptId: 'cpt-elsewhere', name: 'E', aliases: [], summary: 'E.', objectives: [], lessons: [], reviewStatus: 'approved', sourceRefs: cite('video-other:tc-0', 'old')},
    ]
    const existingEdges = [{_id: 'drafts.concept-prereq-x', sourceStatus: 'current', evidence: cite(chunk0.chunkId, chunk0.chunkRevision)}]
    const result = await run({
      generate: perSpan(() => only(null)),
      lessons: lessons({a: {video: video('video-a', 'edited text')}}),
      existingConcepts,
      existingEdges,
    })
    assert.deepEqual(result.staleIds, ['concept-cpt-a', 'drafts.concept-prereq-x'])
    assert.deepEqual(result.transactions[0], [
      {patch: {id: 'concept-cpt-a', set: {sourceStatus: 'stale'}}},
      {patch: {id: 'drafts.concept-prereq-x', set: {sourceStatus: 'stale'}}},
    ])
  })

  it('deletes unreproduced unedited drafts only under force', async () => {
    const first = await run({generate: perSpan(conceptsBySpan)})
    const existing: ExistingConcept[] = first.plan.drafts.map((draft) => ({
      ...draft,
      generationCourse: COURSE._id,
      contentHash: draft.generation.contentHash,
    }))
    const renamed = (call: number): ExtractionOutput => only(concept(`Renamed ${call}`))
    const plain = await run({generate: perSpan(renamed), recorded: recordedFrom(first.records), existingConcepts: existing})
    assert.deepEqual(plain.deletedIds, [])
    const forced = await run({generate: perSpan(renamed), recorded: recordedFrom(first.records), existingConcepts: existing, force: true})
    assert.deepEqual(forced.deletedIds.toSorted(), first.plan.drafts.map((draft) => draft._id).toSorted())
    assert.ok(forced.transactions.at(-1)?.some((mutation) => 'delete' in mutation))
  })
})

describe('findStaleInScope', () => {
  it('judges only refs into the videos the run read', () => {
    assert.equal(videoIdOfChunk('video-youtube-abc:tc-1'), 'video-youtube-abc')
    const docs = [{_id: 'x', refs: [{chunkId: 'video-other:tc-1', chunkRevision: 'r'}]}]
    assert.deepEqual(findStaleInScope(docs, [], new Set(['video-a'])), [])
  })
})

describe('proposePrerequisites', () => {
  const edgeConcept = (conceptId: string): EdgeConcept => ({
    conceptId,
    contentHash: `hash-${conceptId}`,
    name: conceptId,
    summary: `${conceptId}.`,
    evidence: [
      {
        _key: `ref-${conceptId}`,
        _type: 'conceptSourceRef',
        chunkId: `video-a:${conceptId}`,
        chunkRevision: 'rev',
        startSeconds: 0,
        endSeconds: 30,
        lesson: {_type: 'reference', _ref: 'lesson-a'},
        text: `Evidence for ${conceptId}.`,
      },
    ],
  })
  const base = {
    course: COURSE,
    concepts: [edgeConcept('cpt-a'), edgeConcept('cpt-b')],
    existingEdges: [],
    activeEdges: [],
    recordedKeys: new Set<string>(),
    force: false,
    model: MODEL,
    now: NOW,
  }
  const oneEdge: PrerequisiteOutput = {
    edges: [{prerequisite: 0, dependent: 1, rationale: 'B builds on A.', evidence: ['k1e0']}],
    skipReason: null,
  }

  it('writes the edge drafts and the record in one transaction', async () => {
    const result = await proposePrerequisites({...base, generate: fakeModel(() => oneEdge)})
    assert.equal(result.status, 'proposed')
    assert.equal(result.transactions.length, 1)
    const ids = result.transactions[0].map((mutation) => ('createOrReplace' in mutation ? mutation.createOrReplace._id : ''))
    assert.ok(ids[0].startsWith('drafts.concept-prereq-'))
    assert.ok(ids[1].startsWith('concept-generation-'))
    assert.equal(result.record?.draftIds.length, 1)
  })

  it('skips a recorded key unless forced', async () => {
    const first = await proposePrerequisites({...base, generate: fakeModel(() => oneEdge)})
    const model = fakeModel(() => oneEdge)
    const skipped = await proposePrerequisites({...base, generate: model, recordedKeys: new Set([first.record!.key])})
    assert.equal(skipped.status, 'skipped')
    assert.equal(model.calls, 0)
    const forced = await proposePrerequisites({...base, generate: model, recordedKeys: new Set([first.record!.key]), force: true})
    assert.equal(forced.status, 'proposed')
  })

  it('refuses over the concept bound instead of truncating, and skips fewer than two concepts', async () => {
    const model = fakeModel(() => oneEdge)
    const many = Array.from({length: MAX_PREREQUISITE_CONCEPTS + 1}, (_, i) => edgeConcept(`cpt-${String(i).padStart(3, '0')}`))
    assert.equal((await proposePrerequisites({...base, concepts: many, generate: model})).status, 'refused')
    assert.equal((await proposePrerequisites({...base, concepts: [edgeConcept('cpt-a')], generate: model})).status, 'skipped')
    assert.equal(model.calls, 0)
  })

  it('records nothing when the call fails', async () => {
    const result = await proposePrerequisites({...base, generate: fakeModel(() => new Error('down'))})
    assert.equal(result.status, 'failed')
    assert.equal(result.record, null)
    assert.deepEqual(result.transactions, [])
  })
})

describe('proposeMerges', () => {
  const consolidationConcept = (conceptId: string): ConsolidationConcept => ({
    conceptId,
    name: conceptId,
    aliases: [],
    summary: `${conceptId}.`,
    candidateIds: [`cand-${conceptId}`],
    evidence: [
      {
        _key: `ref-${conceptId}`,
        _type: 'conceptSourceRef',
        chunkId: `video-a:${conceptId}`,
        chunkRevision: 'rev',
        startSeconds: 0,
        endSeconds: 30,
        lesson: {_type: 'reference', _ref: 'lesson-a'},
        text: `Evidence for ${conceptId}.`,
      },
    ],
  })
  const base = {
    course: COURSE,
    concepts: [consolidationConcept('cpt-a'), consolidationConcept('cpt-b'), consolidationConcept('cpt-c')],
    existingProposals: [],
    recordedKeys: new Set<string>(),
    force: false,
    model: MODEL,
    now: NOW,
  }
  const oneGroup: ConsolidationOutput = {
    groups: [{members: [0, 1], canonical: 0, relation: 'same_concept', rationale: 'Both name the same concept.', evidence: ['k1e0']}],
    skipReason: null,
  }

  it('writes proposal drafts and the record in one transaction and estimates the consolidated count', async () => {
    const result = await proposeMerges({...base, generate: fakeModel(() => oneGroup)})
    assert.equal(result.status, 'proposed')
    assert.equal(result.estimatedCount, 2)
    const ids = result.transactions[0].map((mutation) => ('createOrReplace' in mutation ? mutation.createOrReplace._id : ''))
    assert.ok(ids[0].startsWith('drafts.concept-merge-'))
    assert.ok(ids[1].startsWith('concept-generation-'))
    assert.equal(result.record?.kind, 'course_consolidation')
  })

  it('skips a recorded key unless forced, refuses over the bound, and records nothing on failure', async () => {
    const first = await proposeMerges({...base, generate: fakeModel(() => oneGroup)})
    const model = fakeModel(() => oneGroup)
    assert.equal((await proposeMerges({...base, generate: model, recordedKeys: new Set([first.record!.key])})).status, 'skipped')
    const many = Array.from({length: MAX_CONSOLIDATION_CONCEPTS + 1}, (_, i) => consolidationConcept(`cpt-${String(i).padStart(3, '0')}`))
    assert.equal((await proposeMerges({...base, concepts: many, generate: model})).status, 'refused')
    assert.equal(model.calls, 0)
    const failed = await proposeMerges({...base, generate: fakeModel(() => new Error('down'))})
    assert.equal(failed.status, 'failed')
    assert.deepEqual(failed.transactions, [])
  })
})
