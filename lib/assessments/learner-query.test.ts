import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {evaluate, parse} from 'groq-js'

import {LESSON_CHECK_CANDIDATES_QUERY, LESSON_PRACTICE_ITEMS_QUERY} from '../../sanity/queries/assessments.ts'
import {toCheckCandidates, toLearnerAssessments} from './learner.ts'

/**
 * Evaluates the real learner GROQ projection over full assessment documents
 * and checks that nothing private survives the query + parser boundary that
 * PR-4/PR-7 routes will return. No learner API route exists in PR-1.
 */

const LESSON_ID = 'lesson-hooks'
const SECRET_HINT = 'SECRET-HINT-TEXT'
const SECRET_SOURCE = 'SECRET-TRANSCRIPT-TEXT'
const SECRET_REASON = 'SECRET-CORRECT-REASON'
const SECRET_DISTRACTOR_REASON = 'SECRET-DISTRACTOR-REASON'

function assessment(id: string, overrides: Record<string, unknown> = {}) {
  return {
    _id: id,
    _rev: `rev-${id}`,
    _type: 'assessment',
    familyId: id.replace(/^(drafts\.)?assessment-/, '').replace(/-v\d+$/, ''),
    version: Number(id.match(/-v(\d+)$/)?.[1] ?? 1),
    lesson: {_type: 'reference', _ref: LESSON_ID},
    objective: 'Choose the hook that stores state.',
    type: 'apply',
    responseFormat: 'single_choice',
    question: 'Which hook keeps a value between renders?',
    options: [
      {_key: 'opt-a', _type: 'assessmentOption', text: 'useState'},
      {_key: 'opt-b', _type: 'assessmentOption', text: 'useEffect'},
      {_key: 'opt-c', _type: 'assessmentOption', text: 'useMemo'},
    ],
    answerKey: {
      correctOptionId: 'opt-a',
      correctReason: SECRET_REASON,
      distractorReasons: [
        {_key: 'reason-opt-b', _type: 'distractorReason', optionId: 'opt-b', reason: SECRET_DISTRACTOR_REASON},
        {_key: 'reason-opt-c', _type: 'distractorReason', optionId: 'opt-c', reason: SECRET_DISTRACTOR_REASON},
      ],
    },
    hints: {direction: SECRET_HINT, keyConcept: SECRET_HINT, solution: SECRET_HINT},
    sourceChunkRefs: [{_key: 'ref-0', _type: 'sourceChunkRef', chunkId: 'v:tc-0', chunkRevision: 'r', startSeconds: 0, endSeconds: 20}],
    sourceExcerpt: SECRET_SOURCE,
    reviewStatus: 'approved',
    sourceStatus: 'current',
    review: {correct: true, unambiguous: true, note: 'SECRET-REVIEW-NOTE'},
    generation: {spanKey: 'k', inputHash: 'h', model: 'gpt-5-mini', promptVersion: 'v1'},
    ...overrides,
  }
}

const DATASET = [
  assessment('assessment-fam1-v1'),
  assessment('assessment-fam1-v2'),
  assessment('assessment-fam2-v1', {sourceStatus: 'stale'}),
  assessment('assessment-fam3-v1', {reviewStatus: 'needs_review'}),
  assessment('assessment-fam4-v1', {reviewStatus: 'rejected'}),
  assessment('assessment-fam5-v1', {reviewStatus: 'archived'}),
  assessment('drafts.assessment-fam6-v1'),
  assessment('assessment-other-v1', {lesson: {_type: 'reference', _ref: 'lesson-other'}}),
  {_id: 'assessment-generation-k', _type: 'assessmentGenerationRecord', lesson: {_type: 'reference', _ref: LESSON_ID}},
]

/** The server client reads with the published perspective, which excludes drafts and release versions. */
const published = (docs: ReadonlyArray<{_id: string}>) =>
  docs.filter((doc) => !doc._id.startsWith('drafts.') && !doc._id.startsWith('versions.'))

async function runQuery(dataset: unknown[]): Promise<unknown> {
  const value = await evaluate(parse(LESSON_PRACTICE_ITEMS_QUERY), {dataset, params: {lessonId: LESSON_ID}})
  return value.get()
}

const FORBIDDEN_KEYS = [
  'answerKey',
  'correctOptionId',
  'correctOptionIndex',
  'answerIndex',
  'explanation',
  'correctReason',
  'distractorReasons',
  'hints',
  'sourceExcerpt',
  'sourceChunkRefs',
  'review',
  'reviewStatus',
  'sourceStatus',
  'generation',
  'objective',
]

function assertNoPrivateData(value: unknown) {
  const json = JSON.stringify(value)
  for (const key of FORBIDDEN_KEYS) assert.ok(!json.includes(`"${key}"`), `leaked key ${key}`)
  for (const secret of [SECRET_HINT, SECRET_SOURCE, SECRET_REASON, SECRET_DISTRACTOR_REASON, 'SECRET-REVIEW-NOTE']) {
    assert.ok(!json.includes(secret), `leaked ${secret}`)
  }
}

describe('learner practice query', () => {
  it('returns only approved, current, published items for the lesson with allowlisted keys', async () => {
    const rows = await runQuery(published(DATASET))
    assert.ok(Array.isArray(rows))
    assert.deepEqual(
      rows.map((row) => (row as {_id: string})._id),
      ['assessment-fam1-v2'],
    )
    for (const row of rows) {
      assert.deepEqual(Object.keys(row as object).sort(), [
        '_id',
        '_rev',
        'familyId',
        'lessonId',
        'options',
        'question',
        'responseFormat',
        'type',
        'version',
      ])
      for (const option of (row as {options: object[]}).options) assert.deepEqual(Object.keys(option).sort(), ['id', 'text'])
    }
    assertNoPrivateData(rows)
  })

  it('never exposes answers, hints, source text, or review metadata after parsing', async () => {
    const items = toLearnerAssessments(await runQuery(published(DATASET)))
    assert.deepEqual(
      items.map((item) => item._id),
      ['assessment-fam1-v2'],
    )
    assertNoPrivateData(items)
  })

  it('still drops draft rows if a raw-perspective read ever reached the parser', async () => {
    const items = toLearnerAssessments(await runQuery(DATASET))
    assert.ok(items.every((item) => !item._id.startsWith('drafts.')))
    assertNoPrivateData(items)
  })

  it('excludes draft and release ids in the query itself, even on a raw read', async () => {
    const rows = (await runQuery([
      ...DATASET,
      assessment('drafts.assessment-fam1-v3'),
      assessment('versions.r1.assessment-fam1-v4'),
    ])) as Array<{_id: string}>
    // A newer draft or release version must not hide the published latest version either.
    assert.deepEqual(
      rows.map((row) => row._id),
      ['assessment-fam1-v2'],
    )
  })

  it('keeps one row per family before bounding, so older versions never push families out', async () => {
    const families = Array.from({length: 60}, (_, i) => `many${String(i).padStart(2, '0')}`)
    const dataset = families.flatMap((family) => [assessment(`assessment-${family}-v1`), assessment(`assessment-${family}-v2`)])
    const rows = (await runQuery(dataset)) as Array<{familyId: string; version: number}>
    assert.equal(rows.length, 50)
    assert.equal(new Set(rows.map((row) => row.familyId)).size, 50)
    assert.ok(rows.every((row) => row.version === 2))
    assert.equal(toLearnerAssessments(rows).length, 50)
  })

  it('falls back to the latest current version when a newer one is stale, and requires sourceStatus "current"', async () => {
    const rows = (await runQuery([
      assessment('assessment-famA-v1'),
      assessment('assessment-famA-v2', {sourceStatus: 'stale'}),
      assessment('assessment-famB-v1', {sourceStatus: undefined}),
    ])) as Array<{_id: string}>
    assert.deepEqual(
      rows.map((row) => row._id),
      ['assessment-famA-v1'],
    )
  })
})

describe('check candidates query (PR-7)', () => {
  const LESSON = {_id: LESSON_ID, _type: 'lesson'}
  const ref = (key: string, startSeconds: number) => ({_key: key, _type: 'sourceChunkRef', chunkId: `v:${key}`, chunkRevision: 'r', startSeconds, endSeconds: startSeconds + 10})

  async function runCandidates(dataset: unknown[]): Promise<unknown> {
    const value = await evaluate(parse(LESSON_CHECK_CANDIDATES_QUERY), {dataset, params: {lessonId: LESSON_ID}})
    return value.get()
  }

  it('applies the practice rules and adds only the concept reference and earliest cited second', async () => {
    const rows = (await runCandidates([
      LESSON,
      ...published(DATASET),
      assessment('assessment-famC-v1', {
        primaryConcept: {_type: 'reference', _ref: 'concept-cpt-state'},
        sourceChunkRefs: [ref('late', 40), ref('early', 12)],
      }),
    ])) as Array<Record<string, unknown>>
    assert.deepEqual(
      rows.map((row) => Object.keys(row).sort()),
      [
        ['firstSeconds', 'item', 'primaryConceptRef'],
        ['firstSeconds', 'item', 'primaryConceptRef'],
      ],
    )
    assert.deepEqual(
      rows.map((row) => [(row.item as {_id: string})._id, row.primaryConceptRef ?? null, row.firstSeconds]),
      [
        ['assessment-fam1-v2', null, 0],
        ['assessment-famC-v1', 'concept-cpt-state', 12],
      ],
    )
    for (const row of rows) {
      assert.deepEqual(Object.keys(row.item as object).sort(), [
        '_id',
        '_rev',
        'familyId',
        'lessonId',
        'options',
        'question',
        'responseFormat',
        'type',
        'version',
      ])
    }
    assertNoPrivateData(rows)
  })

  it('returns nothing while the lesson itself is unpublished, as issuing does', async () => {
    assert.deepEqual(await runCandidates(published(DATASET)), [])
  })

  it('parses to issuable learner-safe items and drops malformed rows', async () => {
    const rows = (await runCandidates([LESSON, ...published(DATASET)])) as unknown[]
    const candidates = toCheckCandidates([...rows, {item: {_id: 'assessment-broken-v1'}, primaryConceptRef: null, firstSeconds: 3}, null])
    assert.deepEqual(
      candidates.map((candidate) => [candidate.item._id, candidate.primaryConceptRef, candidate.firstSeconds]),
      [['assessment-fam1-v2', null, 0]],
    )
    assertNoPrivateData(candidates)
  })
})
