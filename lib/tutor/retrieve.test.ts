import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {contentTerms} from '../ai/tutor.ts'
import {
  MAX_EVIDENCE_CHARS,
  MAX_LESSON_CHUNKS,
  MAX_WINDOW_CHUNKS,
  NEIGHBOR_HITS,
  resolveLessonScope,
  retrieveEvidence,
  type TutorLessonScope,
} from './retrieve.ts'
import {
  buildChunkSearchQuery,
  buildWindowQuery,
  chunkSearchParams,
  createGroqTutorSource,
  LESSON_CONTEXT_QUERY,
  VIDEOS_QUERY,
} from './source.ts'
import {deterministicTerms} from './terms.ts'
import {EFFECTS_LESSON, FixtureTutorSource, HOOKS_VIDEO_ID, MEMO_VIDEO_ID, READING_LESSON, SAMPLING_LESSON, withSamplingLesson} from './test-source.ts'

async function setup(lessonId = 'lesson-hooks') {
  const source = new FixtureTutorSource()
  const scope = (await resolveLessonScope(source, lessonId)) as TutorLessonScope
  source.calls = []
  return {source, scope}
}

const retrieve = (source: FixtureTutorSource, scope: TutorLessonScope, currentSeconds: number, question: string) =>
  retrieveEvidence(source, scope, {currentSeconds, terms: contentTerms(question)})

const starts = (chunks: ReadonlyArray<{startSeconds: number}>) => chunks.map((chunk) => chunk.startSeconds)

describe('resolveLessonScope', () => {
  it('resolves the lesson video, its duration, and the other course lessons', async () => {
    const {scope} = await setup()
    assert.equal(scope.video?.id, HOOKS_VIDEO_ID)
    assert.equal(scope.durationSeconds, 600)
    assert.deepEqual(
      scope.courseLessons.map((lesson) => lesson.id),
      [READING_LESSON.id, EFFECTS_LESSON.id],
    )
  })

  it('returns null for a lesson that is not published', async () => {
    assert.equal(await resolveLessonScope(new FixtureTutorSource(), 'drafts.lesson-hooks'), null)
  })

  it('falls back to the lesson duration without a video record', async () => {
    const source = new FixtureTutorSource()
    source.videos.clear()
    const scope = await resolveLessonScope(source, 'lesson-hooks')
    assert.deepEqual([scope?.video, scope?.durationSeconds], [null, 600])
  })
})

describe('retrieveEvidence', () => {
  it('searches the window and the lesson for a topical question, and stops there on a strong match', async () => {
    const {source, scope} = await setup()
    const retrieval = await retrieve(source, scope, 110, 'What does useState return?')
    assert.equal(retrieval.scope, 'lesson')
    assert.deepEqual(starts(retrieval.chunks).slice(0, 10), [20, 40, 60, 80, 100, 120, 140, 160, 180, 200])
    assert.deepEqual(source.windows[0], {fromSeconds: 0, toSeconds: 200})
    assert.equal(source.calls.includes('loadVideos'), false, 'the course tier was not searched')
  })

  it('bounds the window at the start and at the end of the video', async () => {
    const {source, scope} = await setup()
    assert.deepEqual(starts((await retrieve(source, scope, 0, 'what does this mean')).chunks), [0, 20, 40, 60, 80])
    const end = await retrieve(source, scope, 600, 'what does this mean')
    assert.deepEqual(starts(end.chunks), [500, 520, 540, 560, 580])
    assert.equal(end.chunks.at(-1)?.endSeconds, 600)
  })

  it('keeps at most the closest window chunks', async () => {
    const {source, scope} = await setup()
    source.chunks.set(
      HOOKS_VIDEO_ID,
      Array.from({length: 120}, (_, i) => ({_key: `k${i}`, startSeconds: i * 5, text: `useState detail ${i}`})),
    )
    const retrieval = await retrieve(source, scope, 300, 'what does this mean?')
    assert.equal(retrieval.chunks.length, MAX_WINDOW_CHUNKS)
    assert.ok(retrieval.chunks.every((chunk) => Math.abs(chunk.startSeconds - 300) <= 40))
  })

  it('reaches a matching chapter outside the window even when the window matches strongly', async () => {
    const {source, scope} = await setup()
    // The learner says "downsides"; the lesson teaches them under "Pros and Cons". The window matches
    // "useState renders" strongly, and the "useState" chapter around the playhead matches too.
    const retrieval = await retrieveEvidence(source, scope, {
      currentSeconds: 110,
      baseTerms: contentTerms('What are the downsides of useState renders?'),
      terms: [...contentTerms('What are the downsides of useState renders?'), 'con'],
    })
    assert.equal(retrieval.scope, 'lesson')
    assert.ok(starts(retrieval.chunks).includes(520), 'the Pros and Cons chunk is retrieved')
    // Chapter fetches never re-read the window (20–200): the rest of "useState", then "Pros and Cons".
    assert.deepEqual(source.windows.slice(1, 3), [
      {fromSeconds: 201, toSeconds: 379},
      {fromSeconds: 500, toSeconds: 599},
    ])
  })

  it('does not stop at a window chunk sharing only one of several question terms', async () => {
    const {source, scope} = await setup()
    // Window chunks mention "renders", but only chunk 420 has "effect" and "cleanup" together.
    const retrieval = await retrieve(source, scope, 110, 'effect cleanup renders')
    assert.equal(retrieval.scope, 'lesson')
    assert.ok(starts(retrieval.chunks).includes(420))
  })

  it('expands to the lesson when the window does not mention the question, excluding the window', async () => {
    const {source, scope} = await setup()
    const retrieval = await retrieve(source, scope, 110, 'When does the effect cleanup run?')
    assert.equal(retrieval.scope, 'lesson')
    assert.equal(source.calls.filter((call) => call === 'searchChunks').length, 1)
    assert.equal(source.calls.includes('loadVideos'), false)
    assert.ok(starts(retrieval.chunks).includes(420))
    assert.equal(retrieval.chunks.filter((chunk) => chunk.startSeconds > 200).every((chunk) => chunk.lessonId === 'lesson-hooks'), true)
  })

  it('expands to the course and cites the lesson that uses the matching video', async () => {
    const {source, scope} = await setup()
    const retrieval = await retrieve(source, scope, 110, 'How does useMemo cache things?')
    assert.equal(retrieval.scope, 'course')
    const memo = retrieval.chunks.find((chunk) => chunk.chunkId === `${MEMO_VIDEO_ID}:tc-60`)
    assert.deepEqual([memo?.lessonId, memo?.lessonSlug, memo?.endSeconds], [EFFECTS_LESSON.id, EFFECTS_LESSON.slug, 90])
  })

  describe('on the published "Temperature and sampling" layout', () => {
    const DOWNSIDES = 'What are the downsides of a high temperature?'
    const DOWNSIDE = 359
    const sampling = async (chapters?: Parameters<typeof withSamplingLesson>[1]) => {
      const source = withSamplingLesson(new FixtureTutorSource(), chapters)
      const scope = (await resolveLessonScope(source, SAMPLING_LESSON.id)) as TutorLessonScope
      source.calls = []
      source.windows = []
      return {source, scope}
    }

    it('reaches the downside at 5:59 for the downsides question with no model terms', async () => {
      const {source, scope} = await sampling()
      const retrieval = await retrieveEvidence(source, scope, {currentSeconds: 250, ...deterministicTerms(DOWNSIDES)})
      assert.ok(starts(retrieval.chunks).includes(DOWNSIDE))
      // Through the "Pros and Cons" chapter (310–449), which the list word "cons" matches.
      assert.ok(source.windows.some((range) => range.fromSeconds === 341 && range.toSeconds === 449))
    })

    it('adds the chunk that finishes a hit\'s sentence: 5:41 ("an excessive temperature") → 5:59', async () => {
      // No chapters: only the keyword tier and its neighbours. 5:59 shares no word with the question.
      const {source, scope} = await sampling([])
      const retrieval = await retrieve(source, scope, 250, 'What does an excessive temperature cause?')
      const found = starts(retrieval.chunks)
      assert.ok(found.includes(341) && found.includes(DOWNSIDE))
      assert.equal(found.indexOf(DOWNSIDE), found.indexOf(341) + 1, 'the neighbour follows its hit')
    })

    it('does not give a chapter slot to a chapter wholly inside the window', async () => {
      const {source, scope} = await sampling()
      // At 0:40 "Random Sampling" (1:05–1:49) is inside the window; "Top-k" and "Top-p" take the slots.
      const retrieval = await retrieveEvidence(source, scope, {currentSeconds: 40, ...deterministicTerms('What is nucleus sampling?')})
      assert.deepEqual(source.windows.slice(1, 3), [
        {fromSeconds: 235, toSeconds: 266},
        {fromSeconds: 267, toSeconds: 309},
      ])
      for (const start of [266, 287, 304]) assert.ok(starts(retrieval.chunks).includes(start), `${start}`)
    })

    it('bounds the neighbours', async () => {
      const {source, scope} = await sampling([])
      const retrieval = await retrieve(source, scope, 0, 'temperature sampling probability words')
      assert.equal(source.calls.filter((call) => call === 'loadWindow').length, 1 + NEIGHBOR_HITS)
      const window = 5
      assert.ok(retrieval.chunks.length <= window + MAX_LESSON_CHUNKS + 2 * NEIGHBOR_HITS, `${retrieval.chunks.length}`)
    })
  })

  it('parses chapters leniently and in time order', async () => {
    const source = createGroqTutorSource(async () => [
      {_id: 'video-youtube-a', videoId: 'youtube-a', durationSeconds: 100, chapters: [{startSeconds: 50, label: 'Later'}, {startSeconds: 0, label: 'Intro'}, {label: 'broken'}]},
    ])
    assert.deepEqual((await source.loadVideos(['youtube-a']))[0].chapters, [
      {startSeconds: 0, label: 'Intro'},
      {startSeconds: 50, label: 'Later'},
    ])
  })

  it('stays in the window for a question with no topic words', async () => {
    const {source, scope} = await setup()
    const retrieval = await retrieve(source, scope, 410, 'what does this mean?')
    assert.equal(retrieval.scope, 'window')
    assert.deepEqual(source.calls, ['loadWindow'])
  })

  it('searches the course for a lesson without a video, and finds nothing for an off-topic question', async () => {
    const {source, scope} = await setup('lesson-reading')
    assert.equal(scope.video, null)
    const memo = await retrieve(source, scope, 0, 'useMemo')
    assert.equal(memo.scope, 'course')
    assert.equal(memo.chunks[0]?.lessonId, EFFECTS_LESSON.id)
    const offTopic = await retrieve(source, scope, 0, 'quantum chromodynamics')
    assert.deepEqual([offTopic.scope, offTopic.chunks.length], ['course', 0])
  })

  it('reports the lesson scope when there is no course to widen to', async () => {
    const {source, scope} = await setup()
    const retrieval = await retrieve(source, {...scope, courseLessons: []}, 110, 'quantum chromodynamics')
    assert.deepEqual([retrieval.scope, retrieval.chunks.length > 0], ['lesson', true])
  })

  it('caps the characters sent to the model', async () => {
    const {source, scope} = await setup()
    source.chunks.set(
      HOOKS_VIDEO_ID,
      Array.from({length: 30}, (_, i) => ({_key: `k${i}`, startSeconds: i * 6, text: `useState ${'x'.repeat(990)} ${i}`})),
    )
    const retrieval = await retrieve(source, scope, 90, 'useState')
    const chars = retrieval.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0)
    // ~1,002 characters each: a ninth chunk would pass the cap.
    assert.ok(chars <= MAX_EVIDENCE_CHARS && retrieval.chunks.length === 8, `${retrieval.chunks.length} chunks, ${chars} chars`)
  })
})

describe('createGroqTutorSource', () => {
  it('passes search terms as wildcarded params, never inlined', async () => {
    const seen: Array<{query: string; params: Record<string, unknown>}> = []
    const source = createGroqTutorSource(async (query, params) => {
      seen.push({query, params})
      return [{_id: HOOKS_VIDEO_ID, chunks: [{_key: 'tc-1', startSeconds: 1, text: 'useState'}, {_key: 'bad'}]}]
    })
    const rows = await source.searchChunks([HOOKS_VIDEO_ID], ['usestate', 'hook'], {fromSeconds: 20, toSeconds: 200}, 8)
    assert.deepEqual(rows, [{videoDocumentId: HOOKS_VIDEO_ID, chunks: [{_key: 'tc-1', startSeconds: 1, text: 'useState'}]}])
    assert.deepEqual(seen[0].params, {videoDocumentIds: [HOOKS_VIDEO_ID], excludeFrom: 20, excludeTo: 200, t0: 'usestate*', t1: 'hook*'})
    assert.equal(seen[0].query.includes('usestate'), false)
    assert.match(seen[0].query, /text match \$t0 \|\| text match \$t1/)
  })

  it('rejects unsafe terms and out-of-range bounds', () => {
    assert.throws(() => chunkSearchParams(['v'], ['use"state'], null), /unsafe search term/)
    assert.throws(() => chunkSearchParams(['v'], ['a*'], null), /unsafe search term/)
    assert.throws(() => buildChunkSearchQuery(13, 8), /term count/)
    assert.throws(() => buildWindowQuery(1000), /chunk limit/)
  })

  it('excludes drafts and release versions in every query and in the parsed rows', async () => {
    for (const query of [LESSON_CONTEXT_QUERY, VIDEOS_QUERY, buildWindowQuery(10), buildChunkSearchQuery(1, 8)]) {
      assert.match(query, /!\(_id in path\("drafts\.\*\*"\)\) && !\(_id in path\("versions\.\*\*"\)\)/)
    }
    const source = createGroqTutorSource(async (query) =>
      query === VIDEOS_QUERY
        ? [
            {_id: 'drafts.video-youtube-a', videoId: 'youtube-a', durationSeconds: 1},
            {_id: 'video-youtube-a', videoId: 'youtube-a', durationSeconds: 10},
            {_id: 'video-youtube-a-dup', videoId: 'youtube-a', durationSeconds: 20},
          ]
        : {_id: 'drafts.lesson-hooks', title: 'x', slug: 'x'},
    )
    assert.equal(await source.loadLesson('lesson-hooks'), null)
    assert.deepEqual(await source.loadVideos(['youtube-a']), [{id: 'video-youtube-a', videoId: 'youtube-a', durationSeconds: 10, chapters: []}])
  })
})
