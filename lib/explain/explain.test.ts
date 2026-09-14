import assert from 'node:assert/strict'
import {existsSync} from 'node:fs'
import {readFile} from 'node:fs/promises'
import {describe, it} from 'node:test'

import {z} from 'zod'

import {chunkRevisionOf} from '../evidence/chunks.ts'
import {explainRequestSchema, explainResponseSchema, type ExplainResponse} from './contracts.ts'
import {checkExpectations, checkStructure, copiesPoint, explainEvalCaseSchema} from './eval-check.ts'
import {classifyExplanation, type ExplanationFacts} from './evidence.ts'
import {evidenceNote, statusText, summarizeFeedback} from './present.ts'
import {createGroqExplanationTaskSource, EXPLANATION_TASK_CHUNKS_QUERY, LESSON_EXPLANATION_TASK_QUERY} from './source.ts'
import {makeTask} from './test-fixtures.ts'
import {locateQuote, MAX_EXPLANATION_CHARS, normalizeExplanation} from './text.ts'

describe('normalizeExplanation', () => {
  it('normalizes line endings and trims, and nothing else', () => {
    assert.deepEqual(normalizeExplanation('  One line\r\nTwo  lines\r\n\n'), {ok: true, text: 'One line\nTwo  lines', charCount: 19})
  })

  it('bounds the length and rejects control characters', () => {
    assert.deepEqual(normalizeExplanation('too short'), {ok: false, problem: 'too_short'})
    assert.deepEqual(normalizeExplanation('x'.repeat(MAX_EXPLANATION_CHARS + 1)), {ok: false, problem: 'too_long'})
    assert.equal(normalizeExplanation('x'.repeat(MAX_EXPLANATION_CHARS)).ok, true)
    assert.deepEqual(normalizeExplanation(`A sentence with a ${String.fromCharCode(0)} byte.`), {ok: false, problem: 'control_characters'})
    assert.equal(normalizeExplanation('Tabs\tare fine here.').ok, true)
  })
})

describe('locateQuote', () => {
  const text = 'The yeast gives off gas.\nSo the dough   rises as it proofs.'

  it('finds a quote ignoring case, whitespace runs, and wrapping quotation marks', () => {
    const span = locateQuote(text, '“so THE dough rises as it proofs…”')!
    assert.equal(text.slice(span.start, span.end), 'So the dough   rises as it proofs')
    const across = locateQuote(text, 'gas. so the')!
    assert.equal(text.slice(across.start, across.end), 'gas.\nSo the')
  })

  it('returns null for absent or trivially short quotes', () => {
    assert.equal(locateQuote(text, 'the oven bakes bread'), null)
    assert.equal(locateQuote(text, 'so'), null)
    assert.equal(locateQuote(text, '""'), null)
  })

  it('maps back correctly past characters whose lower case is longer', () => {
    const turkish = 'İstanbul bakers proof dough.'
    const span = locateQuote(turkish, 'bakers proof')!
    assert.equal(turkish.slice(span.start, span.end), 'bakers proof')
  })
})

const CITATION = {
  chunkId: 'video-youtube-doughvideo01:k1',
  lessonId: 'lesson-why-dough-rises',
  sourceRevision: 'abc',
  startSeconds: 30,
  endSeconds: 45,
  label: 'Why dough rises · 0:30',
  href: '/lessons/why-dough-rises?t=30',
}

function response(overrides: Partial<ExplainResponse> = {}): ExplainResponse {
  return {
    explanationId: '00000000-0000-4000-8000-000000000001',
    taskId: 'dough-rise-and-set',
    taskVersion: 1,
    outcome: 'assessed',
    criteria: [
      {criterionId: 'c-rise', label: 'Rising', required: true, status: 'demonstrated', span: {start: 0, end: 10}, feedback: 'Good.', citations: []},
      {criterionId: 'c-set', label: 'Setting', required: true, status: 'missing', span: null, feedback: null, citations: [CITATION]},
      {criterionId: 'c-salt', label: 'Salt', required: false, status: 'missing', span: null, feedback: null, citations: []},
    ],
    followUpQuestion: 'What does the heat do?',
    charCount: 40,
    attempt: {number: 1, revisionOf: null, cached: false, evidence: {kind: 'independent', reason: 'first_independent_response'}},
    replayed: false,
    provisional: true,
    ...overrides,
  }
}

describe('explain contracts', () => {
  const request = {lessonId: 'lesson-why-dough-rises', taskId: 'dough-rise-and-set', taskVersion: 1, text: 'An explanation.', idempotencyKey: 'key-0123456789abcdef'}

  it('accepts only the listed request keys, so no identity, status, score, or source can be claimed', () => {
    assert.equal(explainRequestSchema.safeParse(request).success, true)
    for (const extra of [{userId: 'user_bob'}, {score: 1}, {criteria: []}, {status: 'demonstrated'}, {sourceIds: ['x']}, {revisionOf: 'x'}]) {
      assert.equal(explainRequestSchema.safeParse({...request, ...extra}).success, false, JSON.stringify(extra))
    }
    assert.equal(explainRequestSchema.safeParse({...request, idempotencyKey: 'short'}).success, false)
  })

  it('accepts a well-formed response and has no score or mastery field', () => {
    assert.equal(explainResponseSchema.safeParse(response()).success, true)
    assert.equal(explainResponseSchema.safeParse({...response(), coverage: 0.5}).success, false)
    assert.equal(explainResponseSchema.safeParse({...response(), mastery: 'mastered'}).success, false)
  })

  it('rejects spans outside the text, quoted missing or unvalidated points, and contradictions without a span or citation', () => {
    const bad = (index: number, patch: object) => {
      const body = response()
      body.criteria[index] = {...body.criteria[index], ...patch}
      return explainResponseSchema.safeParse(body).success
    }
    assert.equal(bad(0, {span: {start: 0, end: 41}}), false)
    assert.equal(bad(1, {span: {start: 0, end: 5}}), false)
    assert.equal(bad(1, {status: 'contradicted', span: {start: 0, end: 5}, citations: []}), false)
    assert.equal(bad(1, {status: 'contradicted', span: null}), false)
    assert.equal(bad(0, {span: null}), false)
    assert.equal(bad(1, {status: 'contradicted', span: {start: 0, end: 5}}), true)
    assert.equal(bad(1, {status: 'not_validated', span: {start: 0, end: 5}}), false)
    assert.equal(bad(1, {status: 'not_validated', feedback: 'Not checked.'}), true)
    assert.equal(explainResponseSchema.safeParse(response({outcome: 'off_topic'})).success, false)
    assert.equal(explainResponseSchema.safeParse(response({outcome: 'off_topic', criteria: [], followUpQuestion: null})).success, true)
  })
})

describe('classifyExplanation', () => {
  const facts: ExplanationFacts = {outcome: 'assessed', identicalBefore: false, priorAssessed: 0, helpLevelBefore: 0}

  it('applies the precedence off-topic, repeat, revision, solution seen, hint, first', () => {
    const table: Array<[Partial<typeof facts>, string]> = [
      [{}, 'independent/first_independent_response'],
      [{helpLevelBefore: 1}, 'assisted/hint_used'],
      [{helpLevelBefore: 3}, 'assisted/answer_exposed'],
      [{priorAssessed: 1, helpLevelBefore: 3}, 'assisted/revision_after_feedback'],
      [{identicalBefore: true, priorAssessed: 2}, 'not_counted/repeat_submission'],
      [{outcome: 'off_topic', identicalBefore: true}, 'not_counted/not_assessable'],
    ]
    for (const [patch, expected] of table) {
      const {kind, reason} = classifyExplanation({...facts, ...patch})
      assert.equal(`${kind}/${reason}`, expected, JSON.stringify(patch))
    }
  })
})

describe('feedback wording', () => {
  it('never shows a score and never reads a missing, unclear, or unsettled point as wrong', () => {
    assert.equal(summarizeFeedback(response()).kind, 'gaps')
    const covered = response()
    covered.criteria[1] = {...covered.criteria[1], status: 'demonstrated', span: {start: 0, end: 5}}
    assert.equal(summarizeFeedback(covered).kind, 'covered')
    const contradicted = response()
    contradicted.criteria[1] = {...contradicted.criteria[1], status: 'contradicted', span: {start: 0, end: 5}}
    assert.equal(summarizeFeedback(contradicted).title, "One point doesn't match the lesson")
    const unsettled = response()
    unsettled.criteria[0] = {...unsettled.criteria[0], status: 'insufficient_evidence'}
    unsettled.criteria[1] = {...unsettled.criteria[1], status: 'unclear'}
    assert.equal(summarizeFeedback(unsettled).kind, 'gaps')
    unsettled.criteria[1] = {...unsettled.criteria[1], status: 'insufficient_evidence'}
    assert.equal(summarizeFeedback(unsettled).kind, 'not_judged')
    // A failed server check is unchecked feedback: not the lesson failing to settle it, nor unclear wording.
    const unchecked = response()
    unchecked.criteria[1] = {...unchecked.criteria[1], status: 'not_validated'}
    assert.equal(summarizeFeedback(unchecked).kind, 'not_validated')
    assert.doesNotMatch(JSON.stringify(summarizeFeedback(unchecked)), /lesson material|settle|unclear|clearer/i)
    assert.equal(statusText({status: 'not_validated', required: true}), "Couldn't be checked")
    unchecked.criteria[0] = {...unchecked.criteria[0], status: 'insufficient_evidence'}
    assert.equal(summarizeFeedback(unchecked).kind, 'not_validated')
    assert.equal(summarizeFeedback({outcome: 'off_topic', criteria: []}).kind, 'off_topic')
    const allText = [covered, contradicted, unsettled, unchecked, response()].map((body) => JSON.stringify(summarizeFeedback(body))).join(' ')
    assert.doesNotMatch(allText, /%|master|score|grade(?!\.)|fail/i)
    assert.equal(statusText({status: 'missing', required: false}), 'Optional extra')
    assert.equal(statusText({status: 'missing', required: true}), 'Not covered yet')
    assert.match(evidenceNote({number: 2, revisionOf: 'x', cached: false, evidence: {kind: 'assisted', reason: 'revision_after_feedback'}})!, /revision/)
    assert.equal(evidenceNote(response().attempt), null)
  })
})

describe('createGroqExplanationTaskSource', () => {
  const VIDEO_DOC = 'video-youtube-doughvideo1'
  const chunkText = {k1: 'The yeast gives off gas.', k2: 'The gluten traps the gas.', k3: 'The heat sets the crumb.'}
  const ref = (key: keyof typeof chunkText, start: number) => ({
    chunkId: `${VIDEO_DOC}:${key}`,
    chunkRevision: chunkRevisionOf({startSeconds: start, text: chunkText[key]}),
    startSeconds: start,
    endSeconds: start + 15,
  })
  const taskRow = () => ({
    _id: 'explanationTask-dough-rise-and-set',
    taskId: 'dough-rise-and-set',
    version: 2,
    title: 'Rising and setting',
    prompt: 'Explain why dough rises while it proofs.',
    criteria: [
      {
        id: 'c-rise',
        label: 'What makes dough rise',
        point: 'Yeast gives off gas that the gluten traps, so the dough rises.',
        required: true,
        objectiveKey: 'obj-1',
        sourceChunkIds: [`${VIDEO_DOC}:k1`, `${VIDEO_DOC}:k2`],
        concept: {_id: 'concept-cpt-a', conceptId: 'cpt-a', name: 'Fermentation', reviewStatus: 'approved', objectiveKeys: ['obj-1']},
      },
      {
        id: 'c-set',
        label: 'Setting',
        point: 'The heat sets the crumb.',
        required: false,
        objectiveKey: null,
        sourceChunkIds: [`${VIDEO_DOC}:k3`],
        concept: {_id: 'concept-cpt-b', conceptId: 'cpt-b', name: 'Baking', reviewStatus: 'approved', objectiveKeys: []},
      },
    ],
    sourceChunkRefs: [ref('k1', 30), ref('k2', 45), ref('k3', 90)],
    lesson: {_id: 'lesson-why-dough-rises', title: 'Why dough rises', slug: 'why-dough-rises', videoUrl: 'https://www.youtube.com/watch?v=doughvideo1'},
  })
  const chunksRow = () => ({
    videoId: 'youtube-doughvideo1',
    chunks: [
      {_key: 'k1', startSeconds: 30, text: chunkText.k1},
      {_key: 'k2', startSeconds: 45, text: chunkText.k2},
      {_key: 'k3', startSeconds: 90, text: chunkText.k3},
    ],
  })

  const sourceOver = (task: unknown, chunks: unknown = chunksRow()) => {
    const calls: Array<{query: string; params: Record<string, unknown>}> = []
    const source = createGroqExplanationTaskSource(async (query, params) => {
      calls.push({query, params})
      return query === LESSON_EXPLANATION_TASK_QUERY ? task : query === EXPLANATION_TASK_CHUNKS_QUERY ? chunks : null
    })
    return {source, calls}
  }

  it('resolves a published task with per-criterion sources, concepts, and hashes, reading only its own chunks', async () => {
    const {source, calls} = sourceOver(taskRow())
    const loaded = await source.loadLessonTask('lesson-why-dough-rises')
    assert.equal(loaded.status, 'ok')
    if (loaded.status !== 'ok') return
    assert.deepEqual(loaded.task.criteria.map((criterion) => [criterion.id, criterion.sources.map((chunk) => chunk.chunkId.split(':')[1])]), [
      ['c-rise', ['k1', 'k2']],
      ['c-set', ['k3']],
    ])
    assert.deepEqual(loaded.task.concepts.map((concept) => concept.conceptId), ['cpt-a', 'cpt-b'])
    assert.match(loaded.task.taskHash, /^[0-9a-f]{64}$/)
    assert.match(loaded.task.rubricHash, /^[0-9a-f]{64}$/)
    assert.deepEqual(calls[1].params, {videoDocumentId: VIDEO_DOC, keys: ['k1', 'k2', 'k3']})
    assert.ok(LESSON_EXPLANATION_TASK_QUERY.includes('!(_id in path("drafts.**"))'))
    assert.ok(LESSON_EXPLANATION_TASK_QUERY.includes('reviewStatus == "approved"'))
  })

  it('changes the hashes when the rubric, a source revision, or the prompt changes', async () => {
    const hashes = async (row: ReturnType<typeof taskRow>) => {
      const loaded = await sourceOver(row).source.loadLessonTask('lesson-why-dough-rises')
      return loaded.status === 'ok' ? [loaded.task.rubricHash, loaded.task.taskHash] : []
    }
    const [rubric, task] = await hashes(taskRow())
    const prompt = taskRow()
    prompt.prompt = 'A different question.'
    const [samePromptRubric, promptTask] = await hashes(prompt)
    assert.equal(samePromptRubric, rubric)
    assert.notEqual(promptTask, task)
    const point = taskRow()
    point.criteria[0].point = 'A changed point.'
    assert.notEqual((await hashes(point))[0], rubric)
  })

  it('withholds a task whose chunk changed, whose concept is withdrawn, or whose objective is gone', async () => {
    const changed = chunksRow()
    changed.chunks[1].text = 'Edited transcript text.'
    assert.equal((await sourceOver(taskRow(), changed).source.loadLessonTask('x')).status, 'stale')
    const withdrawn = taskRow()
    withdrawn.criteria[1].concept.reviewStatus = 'archived'
    assert.equal((await sourceOver(withdrawn).source.loadLessonTask('x')).status, 'stale')
    const objective = taskRow()
    objective.criteria[0].objectiveKey = 'obj-gone'
    assert.equal((await sourceOver(objective).source.loadLessonTask('x')).status, 'stale')
    const otherVideo = taskRow()
    otherVideo.lesson.videoUrl = 'https://www.youtube.com/watch?v=othervideo1'
    assert.equal((await sourceOver(otherVideo).source.loadLessonTask('x')).status, 'stale')
  })

  it('withholds a malformed task, never repairing it', async () => {
    const foreign = taskRow()
    foreign.criteria[0].sourceChunkIds = [`${VIDEO_DOC}:k9`]
    const noneRequired = taskRow()
    noneRequired.criteria[0].required = false
    const draft = {...taskRow(), _id: 'drafts.explanationTask-x'}
    for (const row of [foreign, noneRequired, draft, null]) {
      assert.equal((await sourceOver(row).source.loadLessonTask('x')).status, 'none')
    }
  })
})

describe('explain evaluation cases', () => {
  const idsOf = (criteria: Array<{id?: string; _key?: string}>) => new Set(criteria.map((criterion) => criterion.id ?? criterion._key))
  const checkCases = (cases: z.infer<typeof explainEvalCaseSchema>[], ids: Set<string | undefined>) => {
    for (const entry of cases) {
      for (const step of entry.steps) {
        for (const id of Object.keys(step.expect.criteria)) assert.ok(ids.has(id), `${entry.id}: ${id}`)
      }
      if (entry.variant) assert.ok(ids.has(entry.variant.criterionId))
    }
  }

  it('parse the public example cases, which name only the synthetic fixture task', async () => {
    const cases = z.array(explainEvalCaseSchema).parse(JSON.parse(await readFile(new URL('../../docs/explain-back/example.cases.json', import.meta.url), 'utf8')))
    assert.ok(cases.length >= 2)
    checkCases(cases, idsOf(makeTask().criteria))
  })

  // The real task and its cases are kept out of git (docs/explain-back/README.md); checked when present locally.
  const LOCAL = new URL('../../docs/explain-back/local/', import.meta.url)
  const localCases = new URL('sessions-vs-jwt-revocation.cases.json', LOCAL)
  it('parse the local pilot cases against the local draft, which stays unapproved', {skip: !existsSync(localCases) && 'no local pilot task'}, async () => {
    const cases = z.array(explainEvalCaseSchema).parse(JSON.parse(await readFile(localCases, 'utf8')))
    const draft = JSON.parse((await readFile(new URL('sessions-vs-jwt-revocation.draft.ndjson', LOCAL), 'utf8')).trim())
    assert.ok(cases.length >= 9)
    checkCases(cases, idsOf(draft.criteria))
    assert.equal(draft.reviewStatus, 'needs_review')
    assert.ok(Object.values(draft.review).every((value) => value === false), 'no review check is ticked')
  })

  it('checks structure separately from expectations', () => {
    const task = makeTask()
    const text = 'The yeast gives off gas, so the dough rises while it proofs.'
    const analysis = {
      outcome: 'assessed' as const,
      criteria: [
        {criterionId: 'c-rise', label: 'S', required: true, status: 'demonstrated' as const, span: {start: 0, end: 10}, feedback: 'Good.', citations: []},
        {criterionId: 'c-set', label: 'T', required: true, status: 'missing' as const, span: null, feedback: 'Think about the oven.', citations: []},
        {criterionId: 'c-salt', label: 'L', required: false, status: 'missing' as const, span: null, feedback: null, citations: []},
      ],
      followUpQuestion: 'What does the oven heat do to the crumb?',
      dropped: [],
    }
    assert.deepEqual(checkStructure(analysis, task, text), [])
    assert.deepEqual(checkExpectations(analysis, {outcome: ['assessed'], criteria: {'c-set': ['missing']}, forbidStatuses: ['contradicted'], followUp: 'required'}), [])
    assert.deepEqual(checkExpectations(analysis, {outcome: ['assessed'], criteria: {'c-set': ['demonstrated']}, forbidStatuses: ['demonstrated'], followUp: 'any'}), [
      'c-set: missing not in [demonstrated]',
      'c-rise: forbidden demonstrated',
    ])
    const leaky = {...analysis, criteria: analysis.criteria.map((criterion, index) => (index === 1 ? {...criterion, feedback: `Remember: ${task.criteria[1].point}`} : criterion))}
    assert.deepEqual(checkStructure(leaky, task, text), ['c-set: feedback copies a private point'])
    assert.equal(copiesPoint('first makes the trapped gas expand, then sets the crumb', task.criteria[1].point), true)
    assert.equal(copiesPoint('the heat sets the crumb', task.criteria[1].point), false)
  })
})
