import {MockLanguageModelV4} from 'ai/test'

import type {ExplainOutput} from '../ai/explain.ts'
import type {EvidenceChunk} from '../ai/tutor.ts'
import {chunkIdFor, chunkRevisionOf} from '../evidence/chunks.ts'
import {ContentUnavailableError} from '../learner/content-source.ts'
import type {ExplanationTaskSource} from './source.ts'
import {withHashes, type ExplainCriterion, type ExplainTask, type LoadedTask} from './task.ts'

/**
 * Synthetic fixtures for the explain-back tests: a made-up baking lesson with
 * the pilot task's shape (two required points, one optional, and a chunk
 * no point cites). The topic is deliberately unrelated to any course, so
 * this public rubric answers no real task. Every chunk and explanation is
 * written for the tests: no course transcript or learner text appears here.
 */

export const FIXTURE_LESSON = {id: 'lesson-why-dough-rises', title: 'Why dough rises', slug: 'why-dough-rises'}
export const FIXTURE_VIDEO_DOC = 'video-youtube-doughvideo01'

const chunk = (key: string, startSeconds: number, endSeconds: number, text: string): EvidenceChunk => ({
  chunkId: chunkIdFor(FIXTURE_VIDEO_DOC, key),
  chunkRevision: chunkRevisionOf({startSeconds, text}),
  startSeconds,
  endSeconds,
  text,
  lessonId: FIXTURE_LESSON.id,
  lessonTitle: FIXTURE_LESSON.title,
  lessonSlug: FIXTURE_LESSON.slug,
})

export const FIXTURE_EVIDENCE: EvidenceChunk[] = [
  chunk('k1', 30, 45, 'While dough proofs, the yeast feeds on sugars in the flour and gives off gas.'),
  chunk('k2', 45, 60, 'The gluten traps that gas, so the dough rises as it proofs.'),
  chunk('k3', 90, 105, 'In a hot oven the trapped gas expands quickly at first, which gives the loaf its oven spring.'),
  chunk('k4', 105, 120, 'Then the heat sets the crumb, so once the loaf is baked it can no longer rise.'),
  chunk('k5', 150, 165, 'A pinch of salt slows the yeast, which keeps the rise even.'),
  chunk('k6', 200, 215, 'Always preheat the oven fully before baking.'),
]

const byKey = (key: string) => FIXTURE_EVIDENCE.find((entry) => entry.chunkId.endsWith(`:${key}`))!

export const RISING = {conceptId: 'cpt-dough-fermentation', name: 'Dough fermentation'}
export const BAKING = {conceptId: 'cpt-oven-spring', name: 'Oven spring and setting'}

export const CRITERIA: ExplainCriterion[] = [
  {
    id: 'c-rise',
    label: 'What makes dough rise while it proofs',
    point: 'Yeast feeds on sugars and gives off gas, and the gluten traps that gas, so the dough rises while it proofs.',
    required: true,
    concept: RISING,
    objectiveKey: 'obj-rise',
    sources: [byKey('k1'), byKey('k2')],
  },
  {
    id: 'c-set',
    label: 'Why the loaf stops rising in the oven',
    point: 'Oven heat first makes the trapped gas expand, then sets the crumb, so a loaf that is baked can no longer rise.',
    required: true,
    concept: BAKING,
    objectiveKey: null,
    sources: [byKey('k3'), byKey('k4')],
  },
  {
    id: 'c-salt',
    label: 'How salt changes the rise',
    point: 'A little salt slows the yeast, which keeps the rise even.',
    required: false,
    concept: BAKING,
    objectiveKey: null,
    sources: [byKey('k5')],
  },
]

export function makeTask(overrides: Partial<Omit<ExplainTask, 'taskHash' | 'rubricHash'>> = {}): ExplainTask {
  return withHashes({
    documentId: 'explanationTask-dough-rise-and-set',
    taskId: 'dough-rise-and-set',
    version: 1,
    title: 'Rising and setting',
    prompt: 'In your own words, explain why dough rises while it proofs, but stops rising once the loaf is baked.',
    criteria: CRITERIA,
    concepts: [RISING, BAKING],
    lesson: FIXTURE_LESSON,
    evidence: FIXTURE_EVIDENCE,
    ...overrides,
  })
}

export const ACCURATE =
  'The yeast feeds on sugar in the dough and gives off gas, so it rises while it proofs. In the oven the gas expands and then the heat sets the crumb, so a baked loaf cannot rise any more.'

export const RISE_ONLY = 'The yeast feeds on sugar in the dough and gives off gas, and the gluten traps it, so the dough rises while it proofs.'

export const REVERSED =
  'A baked loaf keeps rising for hours after it comes out of the oven. While proofing it cannot rise, because the gas escapes straight out of the dough.'

/** Lesson-scoped task lookup with a call counter; set an entry to simulate a withdrawn or changed task. */
export class FixtureTaskSource implements ExplanationTaskSource {
  tasks = new Map<string, LoadedTask>()
  calls = 0
  fail = false

  constructor(task: ExplainTask | null = makeTask()) {
    if (task) this.tasks.set(task.lesson.id, {status: 'ok', task})
  }

  async loadLessonTask(lessonId: string): Promise<LoadedTask> {
    this.calls++
    if (this.fail) throw new ContentUnavailableError('content down')
    return this.tasks.get(lessonId) ?? {status: 'none'}
  }
}

type Message = {role: string; content: unknown}

export type ExplainInput = {
  question: string
  points: Array<{pointId: string; conveys: string; required: boolean; passageIds: string[]}>
  passages: Array<{passageId: string; startSeconds: number; text: string}>
  explanation: string
}

function inputOf(options: {prompt: ReadonlyArray<Message>}): ExplainInput {
  for (const message of options.prompt) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue
    for (const part of message.content as Array<{type: string; text?: string}>) {
      if (part.type === 'text' && part.text?.startsWith('Input:\n')) return JSON.parse(part.text.slice('Input:\n'.length))
    }
  }
  throw new Error('No explain input in the prompt')
}

/**
 * A plain reading for the tests: a point is demonstrated when the text
 * mentions its subject ("yeast" or "oven" / "heat"), quoting the first
 * sentence that does; everything else is missing.
 */
export function defaultExplain(input: ExplainInput): ExplainOutput {
  const sentences = input.explanation.split(/(?<=\.)\s+/)
  const find = (pattern: RegExp) => sentences.find((sentence) => pattern.test(sentence)) ?? null
  const points = input.points.map(({pointId}) => {
    const quote = pointId === 'c-rise' ? find(/yeast/i) : pointId === 'c-set' ? find(/oven|heat/i) : null
    return quote
      ? {pointId, status: 'demonstrated' as const, quote, passages: [], feedback: 'You explained this accurately.'}
      : {pointId, status: 'missing' as const, quote: null, passages: [], feedback: 'Think about what happens here.'}
  })
  const gap = points.some((point) => point.status === 'missing' && input.points.find((entry) => entry.pointId === point.pointId)?.required)
  return {status: 'assessed', points, followUpQuestion: gap ? 'What does the oven heat do to the crumb?' : null}
}

export type ExplainModelHandlers = {
  explain?: (input: ExplainInput) => unknown
  /** Awaited before answering (to hold a claim open in concurrency tests). */
  gate?: () => Promise<void>
  /** Part of the cache key: a different model evaluates again. */
  modelId?: string
}

const usage = {
  inputTokens: {total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined},
  outputTokens: {total: 20, text: 20, reasoning: undefined},
}

/** A mock model answering the explain call from `handlers` (a handler may throw to simulate a provider failure). */
export function explainModel(handlers: ExplainModelHandlers = {}) {
  const model = new MockLanguageModelV4({
    ...(handlers.modelId ? {modelId: handlers.modelId} : {}),
    doGenerate: async (options) => {
      const input = inputOf(options as {prompt: ReadonlyArray<Message>})
      model.calls++
      model.inputs.push(input)
      await handlers.gate?.()
      const output = (handlers.explain ?? defaultExplain)(input)
      return {content: [{type: 'text', text: JSON.stringify(output)}], finishReason: {unified: 'stop', raw: undefined}, usage, warnings: []}
    },
  }) as MockLanguageModelV4 & {calls: number; inputs: ExplainInput[]}
  model.calls = 0
  model.inputs = []
  return model
}

export function failingExplainModel() {
  return explainModel({
    explain: () => {
      throw new Error('provider exploded')
    },
  })
}
