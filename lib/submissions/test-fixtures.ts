import {MockLanguageModelV4} from 'ai/test'

import type {EvidenceChunk} from '../ai/tutor.ts'
import {chunkIdFor, chunkRevisionOf} from '../evidence/chunks.ts'
import {ContentUnavailableError} from '../learner/content-source.ts'
import type {SubmissionTaskSource} from './source.ts'
import {taskHashOf, type LoadedTask, type SubmissionTask} from './task.ts'

/**
 * Synthetic fixtures for the submission review tests. The task mirrors the
 * pilot draft (`docs/submission-review/`), but its transcript chunks and
 * every code sample are written for the tests: no course transcript or
 * learner code appears in this public repository.
 */

export const SQL_LESSON = {id: 'lesson-sql', title: 'SQL injection basics', slug: 'sql-injection-basics'}
export const SQL_VIDEO_DOC = 'video-youtube-sqlvideo001'

const chunk = (key: string, startSeconds: number, endSeconds: number, text: string): EvidenceChunk => ({
  chunkId: chunkIdFor(SQL_VIDEO_DOC, key),
  chunkRevision: chunkRevisionOf({startSeconds, text}),
  startSeconds,
  endSeconds,
  text,
  lessonId: SQL_LESSON.id,
  lessonTitle: SQL_LESSON.title,
  lessonSlug: SQL_LESSON.slug,
})

export const SQL_EVIDENCE: EvidenceChunk[] = [
  chunk('k1', 20, 40, 'When an app glues user input onto a query string, the input can change what the query does.'),
  chunk('k2', 40, 60, 'A parameterized query keeps the query text fixed and sends each value separately as a bound parameter.'),
  chunk('k3', 60, 80, 'Escaping quotes by hand is not a defence: one missed case and the attacker is back in the query.'),
]

export function makeTask(overrides: Partial<Omit<SubmissionTask, 'taskHash'>> = {}): SubmissionTask {
  const base: Omit<SubmissionTask, 'taskHash'> = {
    documentId: 'submissionTask-sql-user-lookup',
    taskId: 'sql-user-lookup',
    version: 1,
    title: 'Look up a user safely',
    instructions: 'Write findUserByUsername(db, username) that returns the matching users row, or null.',
    language: 'javascript',
    criteria: [
      {id: 'no-query-building', text: 'The username is never inserted into the SQL text itself.'},
      {id: 'bound-parameter', text: 'The username reaches the database as a bound parameter.'},
      {id: 'returns-row-or-null', text: 'The function returns the matching row, or null when none matches.'},
    ],
    concepts: [{conceptId: 'cpt-parameterized-queries', name: 'Parameterized queries'}],
    lesson: SQL_LESSON,
    evidence: SQL_EVIDENCE,
    ...overrides,
  }
  return {...base, taskHash: taskHashOf(base)}
}

export const CONCATENATED = [
  'async function findUserByUsername(db, username) {',
  "  const sql = \"SELECT * FROM users WHERE username = '\" + username + \"'\"",
  '  const result = await db.query(sql)',
  '  return result.rows[0] ?? null',
  '}',
].join('\n')

export const PARAMETERIZED = [
  'async function findUserByUsername(db, username) {',
  "  const result = await db.query('SELECT * FROM users WHERE username = $1', [username])",
  '  return result.rows[0] ?? null',
  '}',
].join('\n')

/** Lesson-scoped task lookup with a call counter; set an entry to simulate a withdrawn or changed task. */
export class FixtureTaskSource implements SubmissionTaskSource {
  tasks = new Map<string, LoadedTask>()
  calls = 0
  fail = false

  constructor(task: SubmissionTask | null = makeTask()) {
    if (task) this.tasks.set(task.lesson.id, {status: 'ok', task})
  }

  async loadLessonTask(lessonId: string): Promise<LoadedTask> {
    this.calls++
    if (this.fail) throw new ContentUnavailableError('content down')
    return this.tasks.get(lessonId) ?? {status: 'none'}
  }
}

type Message = {role: string; content: unknown}

function inputOf(options: {prompt: ReadonlyArray<Message>}): unknown {
  for (const message of options.prompt) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue
    for (const part of message.content as Array<{type: string; text?: string}>) {
      if (part.type === 'text' && part.text?.startsWith('Input:\n')) return JSON.parse(part.text.slice('Input:\n'.length))
    }
  }
  return null
}

export type ReviewInput = {
  task: {criteria: Array<{criterionId: string; text: string}>; instructions: string; language: string}
  concepts: Array<{conceptId: string; name: string}>
  passages: Array<{passageId: string; text: string}>
  submission: {lineCount: number; lines: Array<{line: number; text: string}>}
}

export type CheckInput = {
  task: {criteria: Array<{criterionId: string; text: string}>}
  submission: {lines: Array<{line: number; text: string}>}
  findings: Array<{id: number; category: string; criterionId: string | null; question: string | null; explanation: string; sources: string[]}>
}

/**
 * A finding on the first line that concatenates into the SQL string, citing
 * the passage about gluing input onto a query; every criterion "met" when
 * there is none.
 */
export function defaultReview(input: ReviewInput) {
  const line = input.submission.lines.find((entry) => entry.text.includes('" + '))
  const criteria = input.task.criteria.map(({criterionId}) => ({
    criterionId,
    status: line && criterionId !== 'returns-row-or-null' ? 'not_met' : 'met',
  }))
  if (!line) return {status: 'reviewed', cannotJudgeReason: null, criteria, findings: []}
  return {
    status: 'reviewed',
    cannotJudgeReason: null,
    criteria,
    findings: [
      {
        category: 'requirement_mismatch',
        criterionId: 'no-query-building',
        startLine: line.line,
        endLine: line.line,
        quote: line.text.trim().slice(0, 60),
        conceptIds: ['cpt-parameterized-queries'],
        passages: [input.passages[0].passageId],
        question: 'What happens to this query if the username contains a quote?',
        explanation: 'The username is glued onto the query string, so input can change what the query does.',
        correction: "Use a placeholder: db.query('SELECT * FROM users WHERE username = $1', [username])",
      },
    ],
  }
}

/** Confirms every finding and judges criteria like `defaultReview`. */
export function defaultCheck(input: CheckInput) {
  const concatenates = input.submission.lines.some((entry) => entry.text.includes('" + '))
  return {
    criteria: input.task.criteria.map(({criterionId}) => ({criterionId, verdict: concatenates && criterionId !== 'returns-row-or-null' ? 'not_met' : 'met'})),
    findings: input.findings.map((finding) => ({id: finding.id, verdict: 'confirmed', sourcesSupport: true, questionRevealsFix: false, correctionCompatible: true})),
  }
}

export type ReviewModelHandlers = {
  review?: (input: ReviewInput) => unknown
  check?: (input: CheckInput) => unknown
  /** Awaited before answering a review call (to hold a claim open in concurrency tests). */
  gate?: () => Promise<void>
  /** Part of the cache key: a different model re-reviews. */
  modelId?: string
}

const usage = {
  inputTokens: {total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined},
  outputTokens: {total: 20, text: 20, reasoning: undefined},
}

/** A mock model answering the review and check calls from `handlers` (a handler may throw to simulate a provider failure). */
export function reviewModel(handlers: ReviewModelHandlers = {}) {
  const model = new MockLanguageModelV4({
    ...(handlers.modelId ? {modelId: handlers.modelId} : {}),
    doGenerate: async (options) => {
      const system = (options as {prompt: ReadonlyArray<Message>}).prompt.find((message) => message.role === 'system')?.content
      const isCheck = typeof system === 'string' && system.startsWith("You check another reviewer's review")
      const input = inputOf(options as {prompt: ReadonlyArray<Message>})
      let output: unknown
      if (isCheck) {
        model.checkCalls++
        model.checkInputs.push(input as CheckInput)
        output = (handlers.check ?? defaultCheck)(input as CheckInput)
      } else {
        model.reviewCalls++
        model.reviewInputs.push(input as ReviewInput)
        await handlers.gate?.()
        output = (handlers.review ?? defaultReview)(input as ReviewInput)
      }
      return {content: [{type: 'text', text: JSON.stringify(output)}], finishReason: {unified: 'stop', raw: undefined}, usage, warnings: []}
    },
  }) as MockLanguageModelV4 & {reviewCalls: number; checkCalls: number; reviewInputs: ReviewInput[]; checkInputs: CheckInput[]}
  model.reviewCalls = 0
  model.checkCalls = 0
  model.reviewInputs = []
  model.checkInputs = []
  return model
}

export function failingReviewModel() {
  return reviewModel({
    review: () => {
      throw new Error('provider exploded')
    },
  })
}
