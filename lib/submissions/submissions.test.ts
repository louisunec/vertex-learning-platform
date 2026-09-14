import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {readFileSync} from 'node:fs'

import {chunkRevisionOf} from '../evidence/chunks.ts'
import {reviewHelpActions} from '../lesson/review-actions.ts'
import {reviewRequestSchema} from './contracts.ts'
import {checkReviewStep, reviewEvalCaseSchema} from './eval-check.ts'
import {classifySubmission} from './evidence.ts'
import {createGroqSubmissionTaskSource, LESSON_TASK_QUERY, TASK_CHUNKS_QUERY} from './source.ts'
import {helpFamilyKey, helpSessionKey} from './task.ts'
import {MAX_SUBMISSION_CHARS, MAX_SUBMISSION_LINES, normalizeSubmission} from './text.ts'


describe('normalizeSubmission', () => {
  it('normalizes line endings and trailing whitespace only', () => {
    const result = normalizeSubmission('a\r\n  b\rc  \n\n')
    assert.ok(result.ok)
    assert.deepEqual(result.value.lines, ['a', '  b', 'c'])
    assert.equal(result.value.content, 'a\n  b\nc')
  })

  it('rejects empty, oversized, and control-character input', () => {
    assert.deepEqual(normalizeSubmission(' \n\t '), {ok: false, problem: 'empty'})
    assert.deepEqual(normalizeSubmission('x'.repeat(MAX_SUBMISSION_CHARS + 1)), {ok: false, problem: 'too_long'})
    assert.deepEqual(normalizeSubmission(Array(MAX_SUBMISSION_LINES + 1).fill('x').join('\n')), {ok: false, problem: 'too_many_lines'})
    assert.deepEqual(normalizeSubmission('a\u0000b'), {ok: false, problem: 'control_characters'})
    assert.ok(normalizeSubmission('\tindented').ok)
  })
})

describe('classifySubmission', () => {
  it('counts only a first, unassisted, new submission as independent — and repeats never as more', () => {
    assert.deepEqual(classifySubmission({identicalBefore: false, priorSubmissions: 0, helpLevelBefore: 0}), {kind: 'independent', reason: 'first_independent_response'})
    assert.deepEqual(classifySubmission({identicalBefore: true, priorSubmissions: 1, helpLevelBefore: 0}), {kind: 'not_counted', reason: 'repeat_submission'})
    assert.deepEqual(classifySubmission({identicalBefore: false, priorSubmissions: 1, helpLevelBefore: 1}), {kind: 'assisted', reason: 'hint_used'})
    assert.deepEqual(classifySubmission({identicalBefore: false, priorSubmissions: 1, helpLevelBefore: 3}), {kind: 'assisted', reason: 'answer_exposed'})
    assert.deepEqual(classifySubmission({identicalBefore: false, priorSubmissions: 2, helpLevelBefore: 0}), {kind: 'not_counted', reason: 'repeat_task'})
  })
})

describe('reviewRequestSchema', () => {
  const review = {
    action: 'review',
    lessonId: 'lesson-sql',
    taskId: 'sql-user-lookup',
    taskVersion: 1,
    submission: {type: 'snippet', content: 'x'},
    requestKey: 'k'.repeat(20),
  }

  it('rejects client claims to identity, help level, or a verdict', () => {
    assert.ok(reviewRequestSchema.safeParse(review).success)
    for (const extra of [{userId: 'user_x'}, {level: 3}, {outcome: 'no_issues_found'}]) {
      assert.equal(reviewRequestSchema.safeParse({...review, ...extra}).success, false, JSON.stringify(extra))
    }
    assert.equal(reviewRequestSchema.safeParse({...review, submission: {type: 'github_file', url: 'https://github.com/a/b'}}).success, false)
    assert.equal(reviewRequestSchema.safeParse({action: 'help', reviewId: crypto.randomUUID(), request: 'hint', requestKey: 'k'.repeat(20)}).success, false)
    assert.ok(reviewRequestSchema.safeParse({action: 'help', reviewId: crypto.randomUUID(), request: 'solution', requestKey: 'k'.repeat(20)}).success)
  })
})

describe('help scope keys', () => {
  it('cannot collide with a tutor session id, which never contains ":"', () => {
    assert.equal(helpSessionKey('3f1c2a9e-0000-4000-8000-000000000000'), 'submission-review:3f1c2a9e-0000-4000-8000-000000000000')
    assert.equal(helpFamilyKey('sql-user-lookup'), 'submission-task:sql-user-lookup')
  })
})

describe('reviewHelpActions', () => {
  it('offers the explicit correction request from the first level, and nothing without a problem', () => {
    assert.deepEqual(reviewHelpActions({level: 1, helpWorthy: true}).map((action) => action.request), ['escalate', 'solution'])
    assert.deepEqual(reviewHelpActions({level: 2, helpWorthy: true}).map((action) => action.request), ['solution'])
    assert.deepEqual(reviewHelpActions({level: 3, helpWorthy: true}), [])
    assert.deepEqual(reviewHelpActions({level: 0, helpWorthy: false}), [])
  })
})

describe('createGroqSubmissionTaskSource', () => {
  const video = 'video-youtube-sqlvideo001'
  const chunks = [
    {_key: 'k1', startSeconds: 20, text: 'Glued input changes the query.'},
    {_key: 'k2', startSeconds: 40, text: 'Bind each value as a parameter.'},
  ]
  const ref = (chunk: (typeof chunks)[number], end: number) => ({
    chunkId: `${video}:${chunk._key}`,
    chunkRevision: chunkRevisionOf(chunk),
    startSeconds: chunk.startSeconds,
    endSeconds: end,
  })
  const row = (overrides: Record<string, unknown> = {}) => ({
    _id: 'submissionTask-sql-user-lookup',
    taskId: 'sql-user-lookup',
    version: 1,
    title: 'Look up a user safely',
    instructions: 'Write it.',
    language: 'javascript',
    criteria: [{id: 'c1', text: 'No concatenation.'}],
    concepts: [
      {conceptId: 'cpt-a', name: 'A', reviewStatus: 'approved'},
      {conceptId: 'cpt-b', name: 'B', reviewStatus: 'needs_review'},
      null,
    ],
    sourceChunkRefs: [ref(chunks[0], 40), ref(chunks[1], 60)],
    lesson: {_id: 'lesson-sql', title: 'SQL', slug: 'sql', videoUrl: 'https://www.youtube.com/watch?v=sqlvideo001'},
    ...overrides,
  })

  function sourceWith(task: unknown, stored = chunks, videoId = 'youtube-sqlvideo001') {
    const calls: Array<{query: string; params: Record<string, unknown>}> = []
    const source = createGroqSubmissionTaskSource(async (query, params) => {
      calls.push({query, params})
      if (query === LESSON_TASK_QUERY) return task
      if (query === TASK_CHUNKS_QUERY) {
        const keys = params.keys as string[]
        return {videoId, chunks: stored.filter((chunk) => keys.includes(chunk._key))}
      }
      throw new Error('unexpected query')
    })
    return {source, calls}
  }

  it('resolves the task, its approved concepts, and its chunks by key only', async () => {
    const {source, calls} = sourceWith(row())
    const loaded = await source.loadLessonTask('lesson-sql')
    assert.equal(loaded.status, 'ok')
    if (loaded.status !== 'ok') return
    assert.deepEqual(loaded.task.concepts, [{conceptId: 'cpt-a', name: 'A'}])
    assert.deepEqual(loaded.task.evidence.map((chunk) => [chunk.chunkId, chunk.startSeconds, chunk.endSeconds]), [
      [`${video}:k1`, 20, 40],
      [`${video}:k2`, 40, 60],
    ])
    assert.deepEqual(calls[1].params, {videoDocumentId: video, keys: ['k1', 'k2']})
    assert.match(TASK_CHUNKS_QUERY, /transcriptChunks\[_key in \$keys\]/)
    assert.match(LESSON_TASK_QUERY, /reviewStatus == "approved"/)
    assert.match(LESSON_TASK_QUERY, /!\(_id in path\("drafts\.\*\*"\)\)/)
  })

  it('is stale when a cited chunk changed, moved, vanished, or belongs to another video', async () => {
    const changed = [{...chunks[0], text: 'Different words now.'}, chunks[1]]
    const moved = [{...chunks[0], startSeconds: 21}, chunks[1]]
    assert.equal((await sourceWith(row(), changed).source.loadLessonTask('lesson-sql')).status, 'stale')
    assert.equal((await sourceWith(row(), moved).source.loadLessonTask('lesson-sql')).status, 'stale')
    assert.equal((await sourceWith(row(), [chunks[1]]).source.loadLessonTask('lesson-sql')).status, 'stale')
    assert.equal((await sourceWith(row(), chunks, 'youtube-other').source.loadLessonTask('lesson-sql')).status, 'stale')
    const otherVideo = row({sourceChunkRefs: [{...ref(chunks[0], 40), chunkId: 'video-youtube-elsewhere:k1'}]})
    assert.equal((await sourceWith(otherVideo).source.loadLessonTask('lesson-sql')).status, 'stale')
  })

  it('withholds a missing or malformed task', async () => {
    assert.equal((await sourceWith(null).source.loadLessonTask('lesson-sql')).status, 'none')
    assert.equal((await sourceWith(row({criteria: []})).source.loadLessonTask('lesson-sql')).status, 'none')
    assert.equal((await sourceWith(row({_id: 'drafts.submissionTask-x'})).source.loadLessonTask('lesson-sql')).status, 'none')
  })

  it('changes the task hash when criteria or evidence change, so cached reviews stop applying', async () => {
    const hash = async (task: unknown, stored = chunks) => {
      const loaded = await sourceWith(task, stored).source.loadLessonTask('lesson-sql')
      return loaded.status === 'ok' ? loaded.task.taskHash : null
    }
    const base = await hash(row())
    assert.notEqual(await hash(row({criteria: [{id: 'c1', text: 'No concatenation at all.'}]})), base)
    const edited = {...chunks[1], text: 'Bind every value as a parameter.'}
    assert.notEqual(await hash(row({sourceChunkRefs: [ref(chunks[0], 40), ref(edited, 60)]}), [chunks[0], edited]), base)
    assert.equal(await hash(row()), base)
  })
})

describe('review evaluation cases', () => {
  const cases = JSON.parse(readFileSync(new URL('../../scripts/review-eval-cases.json', import.meta.url), 'utf8')) as unknown[]

  it('parse, cover every required kind, and fit the submission limits', () => {
    const parsed = cases.map((entry) => reviewEvalCaseSchema.parse(entry))
    const kinds = new Set(parsed.map((entry) => entry.kind))
    for (const kind of ['known_defect', 'correct', 'different_correct', 'incomplete_context', 'unfamiliar_approach', 'corrected_resubmission', 'prompt_injection']) {
      assert.ok(kinds.has(kind as never), kind)
    }
    assert.equal(parsed.find((entry) => entry.kind === 'corrected_resubmission')?.steps.length, 2)
    for (const entry of parsed) for (const step of entry.steps) assert.ok(normalizeSubmission(step.code).ok, entry.id)
  })

  it('checks outcome, problem lines, absence of problems, and criteria', () => {
    const analysis = {
      outcome: 'changes_suggested' as const,
      cannotJudgeReason: null,
      criteria: [{criterionId: 'a', status: 'not_met' as const}],
      findings: [{id: 'f1', category: 'defect' as const, criterionId: 'a', startLine: 2, endLine: 3, concepts: [], citations: [], question: 'q', explanation: 'e', correction: null}],
      dropped: [],
    }
    assert.deepEqual(checkReviewStep(analysis, {outcomeIn: ['changes_suggested'], problemOnLines: [3], criteria: {a: ['not_met']}}), [])
    assert.deepEqual(checkReviewStep(analysis, {noProblems: true, problemOnLines: [4], outcomeNot: ['changes_suggested'], criteria: {b: ['met']}}), [
      'outcome changes_suggested must not be one of [changes_suggested]',
      'no problem finding covers line 4',
      'unexpected defect on lines 2–3',
      'criterion b is missing, expected [met]',
    ])
  })
})
