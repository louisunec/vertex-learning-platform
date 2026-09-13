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
  }
  return Array.from({length: 30}, (_, i) => {
    const start = i * 20
    return {_key: `tc-${start}`, startSeconds: start, text: special[start] ?? `${FILLER} part ${i}`}
  })
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
    this.videos.set('youtube-hooksvideo1', {id: HOOKS_VIDEO_ID, videoId: 'youtube-hooksvideo1', durationSeconds: 600})
    this.videos.set('youtube-memovideo01', {id: MEMO_VIDEO_ID, videoId: 'youtube-memovideo01', durationSeconds: 300})
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

/** The sources the tutor put in the user message. */
export function promptSources(options: {prompt: ReadonlyArray<{role: string; content: unknown}>}): PromptSource[] {
  for (const message of options.prompt) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue
    for (const part of message.content as Array<{type: string; text?: string}>) {
      if (part.type === 'text' && part.text?.startsWith('Input:\n')) {
        return (JSON.parse(part.text.slice('Input:\n'.length)) as {sources: PromptSource[]}).sources
      }
    }
  }
  return []
}

/** A model returning `respond(sources)` as its JSON output; `calls` counts invocations. */
export function scriptedModel(respond: (sources: PromptSource[]) => unknown) {
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      model.calls++
      return {
        content: [{type: 'text', text: JSON.stringify(respond(promptSources(options)))}],
        finishReason: {unified: 'stop', raw: undefined},
        usage,
        warnings: [],
      }
    },
  }) as MockLanguageModelV4 & {calls: number}
  model.calls = 0
  return model
}

/** Cites the first source with a claim that repeats its opening words (so it passes the relevance floor). */
export const citingModel = () =>
  scriptedModel((sources) => ({
    status: 'supported',
    statements: [
      {kind: 'connective', text: 'Here is what the lesson says.', evidence: []},
      {
        kind: 'claim',
        text: sources[0].text.split(' ').slice(0, 8).join(' '),
        evidence: [{chunkId: sources[0].chunkId, chunkRevision: sources[0].chunkRevision}],
      },
    ],
    followUp: null,
  }))

/** A model whose provider call fails. */
export function failingModel() {
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      model.calls++
      throw new Error('provider exploded')
    },
  }) as MockLanguageModelV4 & {calls: number}
  model.calls = 0
  return model
}
