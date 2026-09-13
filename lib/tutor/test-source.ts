import {MockLanguageModelV4} from 'ai/test'

import type {StoredChunk} from '../evidence/chunks.ts'
import {tokenize} from '../search/terms.ts'
import type {ChunkRange, TutorLesson, TutorLessonContext, TutorSource, TutorVideo} from './source.ts'

/**
 * In-memory tutor content for tests, shaped like the parsed Sanity rows.
 * `lesson-hooks` matches the lesson of `FixtureContent` assessments, so a
 * task instance issued there belongs to it. Chunks are 20 s apart.
 */

const youtube = (id: string) => `https://www.youtube.com/watch?v=${id}`

export const HOOKS_LESSON: TutorLesson = {
  id: 'lesson-hooks',
  title: 'React hooks',
  slug: 'react-hooks',
  durationSeconds: 600,
  videoUrl: youtube('hooksvideo1'),
}
export const EFFECTS_LESSON: TutorLesson = {
  id: 'lesson-effects',
  title: 'Memoization',
  slug: 'react-memo',
  durationSeconds: 300,
  videoUrl: youtube('memovideo01'),
}
export const READING_LESSON: TutorLesson = {id: 'lesson-reading', title: 'Reading list', slug: 'reading', durationSeconds: null, videoUrl: null}

export const HOOKS_VIDEO_ID = 'video-youtube-hooksvideo1'
export const MEMO_VIDEO_ID = 'video-youtube-memovideo01'

const FILLER = 'the instructor walks through components and rendering on screen'

function hooksChunks(): StoredChunk[] {
  const special: Record<number, string> = {
    100: 'useState stores a value that persists between renders',
    120: 'calling useState returns the current state and a setter function',
    400: 'useEffect runs after render to synchronize with an external system',
    420: 'the effect cleanup runs before the next effect and on unmount',
    520: 'the cons of putting everything in state are extra renders and stale values',
  }
  return Array.from({length: 30}, (_, i) => {
    const start = i * 20
    return {_key: `tc-${start}`, startSeconds: start, text: special[start] ?? `${FILLER} part ${i}`}
  })
}

/**
 * A synthetic "Temperature and sampling" lesson for retrieval and citation
 * regressions. Its chapter labels and chunk start times follow the layout of
 * a real lesson in the dataset; the text is written for these tests (the
 * real transcript is third-party and is not copied here). Like
 * auto-generated captions it has no punctuation and cuts sentences across
 * chunks: the downside of a high temperature starts at 5:41 ("an excessive
 * temperature") and finishes at 5:59, inside the "Pros and Cons" chapter.
 */
export const SAMPLING_LESSON: TutorLesson = {
  id: 'lesson-sampling',
  title: 'Temperature and sampling',
  slug: 'temperature-and-sampling',
  durationSeconds: 491,
  videoUrl: youtube('samplingvid'),
}
export const SAMPLING_VIDEO_ID = 'video-youtube-samplingvid'
export const SAMPLING_CHAPTERS = [
  {startSeconds: 0, label: 'Intro'},
  {startSeconds: 37, label: 'Greedy Decoding'},
  {startSeconds: 65, label: 'Random Sampling'},
  {startSeconds: 110, label: 'Temperature'},
  {startSeconds: 235, label: 'Top-k Sampling'},
  {startSeconds: 267, label: 'Top-p Sampling'},
  {startSeconds: 310, label: 'Pros and Cons'},
  {startSeconds: 450, label: 'Outro'},
]
export const SAMPLING_CHUNKS: StoredChunk[] = [
  {_key: 'tc-0', startSeconds: 0, text: "welcome to this session on how a language model picks its next word we will look at temperature and two cutoff methods and how each one shapes what the model writes"},
  {_key: 'tc-17', startSeconds: 17, text: "a model produces text one token at a time and at every step it scores all the candidate words and turns those scores into a list of probabilities"},
  {_key: 'tc-34', startSeconds: 34, text: "the simplest rule is to always take the most likely word which is called greedy decoding and for the phrase the sky looks it would pick blue every"},
  {_key: 'tc-52', startSeconds: 52, text: "single time which makes the output predictable and repetitive that suits tasks like transcription where you want exactly one answer but most writing tasks want some"},
  {_key: 'tc-70', startSeconds: 70, text: "variety so instead of always taking the top word we draw from the distribution and three settings temperature plus the k and p cutoffs decide how that draw behaves which"},
  {_key: 'tc-86', startSeconds: 86, text: "gives the model room to produce fresh and varied sentences that still fit the context and that is why sampling is popular for chat assistants and story writing tools"},
  {_key: 'tc-105', startSeconds: 105, text: "the first setting we will cover is temperature which adjusts how random the draw is by changing the scores before they pass through the softmax step that turns"},
  {_key: 'tc-121', startSeconds: 121, text: "raw scores into probabilities that add up to one in practice every score is divided by the temperature value theta which you choose before generation begins so"},
  {_key: 'tc-139', startSeconds: 139, text: "the temperature reshapes the probability distribution before sampling a larger theta means dividing by a bigger number which pulls the probabilities closer together and"},
  {_key: 'tc-157', startSeconds: 157, text: "spreads the chances out so unlikely words get picked more often while a smaller theta divides by a small number which pushes the probabilities apart and concentrates the"},
  {_key: 'tc-176', startSeconds: 176, text: "chances on the leading words so the text becomes steadier and more predictable now let us try the phrase the sky looks and see how the next word shifts as we"},
  {_key: 'tc-193', startSeconds: 193, text: "vary the temperature at theta equal to one nothing shifts and we sample from the original distribution but if we raise theta to two every probability moves toward the"},
  {_key: 'tc-209', startSeconds: 209, text: "middle so a rarer word like grey becomes a realistic choice and if we lower theta to one half the gaps grow so the leading candidate blue becomes"},
  {_key: 'tc-228', startSeconds: 228, text: "almost certain to be chosen next comes top k sampling where the model keeps only the k highest scoring words at each step and draws its choice from that short list"},
  {_key: 'tc-246', startSeconds: 246, text: "the value of k sets the size of the list so a small k keeps things safe and a large k allows more variety and the cut removes very unlikely tokens that would"},
  {_key: 'tc-266', startSeconds: 266, text: "only add noise the last technique is top p also called nucleus sampling where the model keeps the smallest group of words whose combined probability passes a threshold p"},
  {_key: 'tc-287', startSeconds: 287, text: "because that group grows or shrinks with the shape of the distribution the model considers more words when it is uncertain and fewer when one word clearly dominates which keeps a"},
  {_key: 'tc-304', startSeconds: 304, text: "reasonable balance of variety and focus and often reads more coherent compared to top k sampling to sum up these three settings give you several ways to steer the model and in the"},
  {_key: 'tc-322', startSeconds: 322, text: "final part we weigh the pros and cons of every setting so you can decide which to use for temperature the main benefit is that a higher value makes the writing more"},
  {_key: 'tc-341', startSeconds: 341, text: "inventive and less repetitive which helps for brainstorming or fiction however on the downside an excessive temperature"},
  {_key: 'tc-359', startSeconds: 359, text: "tends to produce rambling sentences that drift away from the topic since the model keeps choosing unlikely words and the result can stop making sense for top k"},
  {_key: 'tc-377', startSeconds: 377, text: "the upside is tight control over variety since only the most likely words survive which avoids strange output but when k is too small the model"},
  {_key: 'tc-396', startSeconds: 396, text: "tends to repeat itself as it sticks to the safest tokens and choosing k well takes care to strike a balance between variety and coherence for top p the dynamic"},
  {_key: 'tc-418', startSeconds: 418, text: "set size means the list adapts to each step and it gives measured randomness while keeping the choices varied on the minus side picking a good p value can"},
  {_key: 'tc-436', startSeconds: 436, text: "take trial and error and a list that shifts too much may cost a little coherence in closing each method trades randomness against predictability"},
  {_key: 'tc-454', startSeconds: 454, text: "and the right choice depends on the task at hand and on how creative or how precise you need the generated text to be"},
  {_key: 'tc-473', startSeconds: 473, text: "that wraps up this session thanks for watching and see you in the next one"},
]

/** Adds the sampling lesson, alone in its course, to `source`. */
export function withSamplingLesson(source: FixtureTutorSource, chapters = SAMPLING_CHAPTERS): FixtureTutorSource {
  source.lessons.set(SAMPLING_LESSON.id, {...SAMPLING_LESSON, courseLessons: [SAMPLING_LESSON]})
  source.videos.set('youtube-samplingvid', {id: SAMPLING_VIDEO_ID, videoId: 'youtube-samplingvid', durationSeconds: 491, chapters})
  source.chunks.set(SAMPLING_VIDEO_ID, SAMPLING_CHUNKS)
  return source
}

export class FixtureTutorSource implements TutorSource {
  lessons = new Map<string, TutorLessonContext>()
  videos = new Map<string, TutorVideo>()
  chunks = new Map<string, StoredChunk[]>()
  calls: string[] = []
  windows: ChunkRange[] = []

  constructor() {
    const course = [HOOKS_LESSON, READING_LESSON, EFFECTS_LESSON]
    for (const lesson of course) this.lessons.set(lesson.id, {...lesson, courseLessons: course})
    this.videos.set('youtube-hooksvideo1', {
      id: HOOKS_VIDEO_ID,
      videoId: 'youtube-hooksvideo1',
      durationSeconds: 600,
      chapters: [
        {startSeconds: 0, label: 'Intro'},
        {startSeconds: 80, label: 'useState'},
        {startSeconds: 380, label: 'Effects'},
        {startSeconds: 500, label: 'Pros and Cons'},
      ],
    })
    this.videos.set('youtube-memovideo01', {id: MEMO_VIDEO_ID, videoId: 'youtube-memovideo01', durationSeconds: 300, chapters: []})
    this.chunks.set(HOOKS_VIDEO_ID, hooksChunks())
    this.chunks.set(MEMO_VIDEO_ID, [
      {_key: 'tc-0', startSeconds: 0, text: 'welcome back to the course'},
      {_key: 'tc-60', startSeconds: 60, text: 'useMemo caches an expensive calculation between renders'},
    ])
  }

  async loadLesson(lessonId: string) {
    this.calls.push('loadLesson')
    return this.lessons.get(lessonId) ?? null
  }

  async loadVideos(videoIds: readonly string[]) {
    this.calls.push('loadVideos')
    return videoIds.flatMap((id) => this.videos.get(id) ?? [])
  }

  async loadWindow(videoDocumentId: string, range: ChunkRange, limit: number) {
    this.calls.push('loadWindow')
    this.windows.push(range)
    return (this.chunks.get(videoDocumentId) ?? [])
      .filter((chunk) => chunk.startSeconds >= range.fromSeconds && chunk.startSeconds <= range.toSeconds)
      .slice(0, limit)
  }

  async searchChunks(videoDocumentIds: readonly string[], terms: readonly string[], exclude: ChunkRange | null, perVideo: number) {
    this.calls.push('searchChunks')
    return videoDocumentIds.map((videoDocumentId) => ({
      videoDocumentId,
      chunks: (this.chunks.get(videoDocumentId) ?? [])
        .filter((chunk) => !exclude || chunk.startSeconds < exclude.fromSeconds || chunk.startSeconds > exclude.toSeconds)
        .filter((chunk) => tokenize(chunk.text).some((token) => terms.some((term) => token.startsWith(term))))
        .slice(0, perVideo),
    }))
  }
}

const usage = {
  inputTokens: {total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined},
  outputTokens: {total: 40, text: 40, reasoning: undefined},
}

type PromptSource = {chunkId: string; chunkRevision: string; text: string}
export type PromptPassage = {passageId: string; chunks: PromptSource[]}
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

/** The passages the tutor put in the user message. */
export function promptPassages(options: {prompt: ReadonlyArray<Message>}): PromptPassage[] {
  return (inputOf(options) as {passages?: PromptPassage[]} | null)?.passages ?? []
}

/** The chunks of those passages, in order. */
export function promptSources(options: {prompt: ReadonlyArray<Message>}): PromptSource[] {
  return promptPassages(options).flatMap((passage) => passage.chunks)
}

export type SupportInput = {
  question: string
  items: Array<{id: number; kind: string; text: string; sources: string[]}>
  answerSources?: string[]
  guidingQuestion: string | null
}

type Task = 'answer' | 'direction' | 'support'

function taskOf(options: {prompt: ReadonlyArray<Message>}): Task {
  const system = options.prompt.find((message) => message.role === 'system')?.content
  const text = typeof system === 'string' ? system : ''
  if (text.startsWith('You check a tutor answer')) return 'support'
  return text.includes('Help level 1 (direction)') ? 'direction' : 'answer'
}

export type TutorModelHandlers = {
  /** Levels 2–3 output (default: one claim repeating the first chunk's opening words, citing its passage). */
  answer?: (sources: PromptSource[], question: string, passages: PromptPassage[]) => unknown
  /** Level 1 output (default: point at the first source sharing a question word, one neutral guiding question). */
  direction?: (sources: PromptSource[], question: string) => unknown
  /** Support verdicts (default: every item supported, no leak). */
  support?: (input: SupportInput) => unknown
}

export const DEFAULT_GUIDING_QUESTION = 'What does the instructor emphasise at that point?'

const defaults: Required<TutorModelHandlers> = {
  answer: (sources, _question, passages) => ({
    status: 'supported',
    statements: [
      {kind: 'connective', text: 'Here is what the lesson says.', passages: []},
      {kind: 'claim', text: sources[0].text.split(' ').slice(0, 8).join(' '), passages: [passages[0].passageId]},
    ],
    followUp: null,
  }),
  direction: (sources, question) => {
    const words = tokenize(question).filter((word) => word.length >= 4)
    const source = sources.find((candidate) => tokenize(candidate.text).some((token) => words.includes(token))) ?? sources[0]
    return {
      status: 'supported',
      pointers: [{chunkId: source.chunkId, chunkRevision: source.chunkRevision}],
      guidingQuestion: DEFAULT_GUIDING_QUESTION,
    }
  },
  support: (input) => ({verdicts: input.items.map((item) => ({id: item.id, verdict: 'supported'})), guidingQuestionRevealsAnswer: false}),
}

/**
 * A mock model that answers each tutor task from `handlers` (a handler may
 * throw to simulate a provider failure). `calls` counts answer calls (levels
 * 1–3); `callsByTask` counts every task; `supportInputs` records what the
 * support check was shown.
 */
export function tutorModel(handlers: TutorModelHandlers = {}) {
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      const task = taskOf(options as {prompt: ReadonlyArray<Message>})
      model.callsByTask[task]++
      const input = inputOf(options as {prompt: ReadonlyArray<Message>})
      let output: unknown
      if (task === 'support') {
        model.supportInputs.push(input as SupportInput)
        output = (handlers.support ?? defaults.support)(input as SupportInput)
      } else {
        model.calls++
        const {passages, question} = input as {passages: PromptPassage[]; question: string}
        const sources = passages.flatMap((passage) => passage.chunks)
        output =
          task === 'direction'
            ? (handlers.direction ?? defaults.direction)(sources, question)
            : (handlers.answer ?? defaults.answer)(sources, question, passages)
      }
      return {content: [{type: 'text', text: JSON.stringify(output)}], finishReason: {unified: 'stop', raw: undefined}, usage, warnings: []}
    },
  }) as MockLanguageModelV4 & {calls: number; callsByTask: Record<Task, number>; supportInputs: SupportInput[]}
  model.calls = 0
  model.callsByTask = {answer: 0, direction: 0, support: 0}
  model.supportInputs = []
  return model
}

/** Levels 2–3 answer from `respond`, everything else by default. */
export const scriptedModel = (respond: (sources: PromptSource[], question: string, passages: PromptPassage[]) => unknown) =>
  tutorModel({answer: respond})

/** Cites the first source with a claim that repeats its opening words (so it passes the relevance floor). */
export const citingModel = () => tutorModel()

/** A model whose every provider call fails. */
export function failingModel() {
  const fail = () => {
    throw new Error('provider exploded')
  }
  return tutorModel({answer: fail, direction: fail, support: fail})
}
