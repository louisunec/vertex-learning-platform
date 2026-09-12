import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {mkdtemp, rm} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {after, before, describe, it} from 'node:test'

import {evaluate, parse} from 'groq-js'

import {findChrome, makeVisualFixtures} from '../../scripts/fixtures/make-visual-fixtures.mts'
import {parseVideoUrl} from '../video/provider.ts'
import {DEFAULT_VISUAL_CONFIG} from '../visual/budget.ts'
import {buildVisualIndex, type VideoVisualIndexDocument} from '../visual/index.ts'
import {hasMediaTools, openLocalMedia} from '../visual/media.ts'
import {createTesseractEngine} from '../visual/ocr.ts'
import {
  buildCourseCandidatesQuery,
  buildLessonCandidatesQuery,
  buildVideoCandidatesQuery,
  buildVisualCandidatesQuery,
  LESSON_VIDEO_INDEX_QUERY,
  MAX_MOMENTS_PER_VIDEO,
  MAX_VISUAL_LINES,
} from './queries.ts'
import {rankCandidates} from './rank.ts'
import {parseCourseCandidates, parseLessonCandidates, parseVideoMomentCandidates} from './retrieve.ts'
import {searchResponseSchema} from './schema.ts'
import {fallbackTerms} from './terms.ts'

/**
 * End-to-end visual retrieval (PR-2 follow-up): a real visual index built
 * from the `visual-diagram` fixture (ffmpeg + OCR, stubbed VLM) is searched
 * through the real query, parse, rank, and Zod path. The Context scope is
 * emulated locally by combining the repo Context document's `groqFilter`
 * with each document filter under the published perspective; row validation
 * is also exercised with the perspective removed. No Sanity reads or writes;
 * the live MCP is not exercised.
 */

const NEW_FILTER = (
  JSON.parse(readFileSync(path.join(import.meta.dirname, '../../studio/scripts/context/search-context.ndjson'), 'utf8')) as {
    groqFilter: string
  }
).groqFilter
const LIVE_FILTER = '_type in ["course", "lesson", "video", "instructor", "category"]'

const VIDEO_URL = 'https://www.youtube.com/watch?v=VisTodos001'
const video = parseVideoUrl(VIDEO_URL)!
const TRANSCRIPT = [
  {_key: 'tc-0-0', startSeconds: 0, text: 'Today we memoize a derived list so it only recomputes when its inputs change.'},
  {_key: 'tc-4-1', startSeconds: 4, text: 'Next, how the component tree renders, and where the time goes.'},
]

const missing = [(await hasMediaTools()) ? null : 'ffmpeg/ffprobe (PATH or FFMPEG_PATH/FFPROBE_PATH)', findChrome() ? null : 'Chrome (CHROME_PATH)']
  .filter(Boolean)
  .join(' and ')
const skip = missing ? `visual retrieval end-to-end test needs ${missing}` : false

type Doc = {_id: string; _type: string; [key: string]: unknown}

const scoped = (query: string, groqFilter: string) =>
  query.replaceAll('*[', `*[(${groqFilter}) && `)
const published = (docs: Doc[]) => docs.filter((doc) => !doc._id.startsWith('drafts.') && !doc._id.startsWith('versions.'))
const run = async (query: string, groqFilter: string, docs: Doc[]) =>
  (await evaluate(parse(scoped(query, groqFilter)), {dataset: docs})).get()

describe('visual retrieval through the Context scope', {skip, timeout: 240_000}, () => {
  let dir = ''
  let index: VideoVisualIndexDocument
  let raw: Doc[]

  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vertex-visual-retrieval-'))
    const [fixtures, ocr] = await Promise.all([makeVisualFixtures(dir, ['visual-diagram']), createTesseractEngine()])
    try {
      const media = await openLocalMedia({file: fixtures['visual-diagram'], videoDocumentId: video.documentId})
      ;({document: index} = await buildVisualIndex({
        media,
        ocr,
        describe: async () => ({
          status: 'described',
          label: 'diagram',
          text: 'Unlabelled component tree with one highlighted leaf node',
          usage: {inputTokens: null, outputTokens: null},
        }),
        transcript: TRANSCRIPT.map((chunk) => ({...chunk, endSeconds: chunk.startSeconds + 4})),
        config: DEFAULT_VISUAL_CONFIG,
      }))
    } finally {
      await ocr.terminate()
    }
    const decoy = (id: string, identifier: string): Doc => ({
      ...index,
      _id: id,
      chunks: [{...index.chunks[0], _key: 'decoy', text: `const ${identifier} = createSelector()`}],
    })
    raw = [
      {
        _id: 'course-state',
        _type: 'course',
        title: 'State management',
        slug: {_type: 'slug', current: 'state-management'},
        modules: [
          {_key: 'm1', _type: 'module', title: 'Selectors', lessons: [{_key: 'l1', _type: 'reference', _ref: 'lesson-selectors'}]},
        ],
      },
      {_id: 'lesson-selectors', _type: 'lesson', title: 'Memoized selectors', slug: {_type: 'slug', current: 'memoized-selectors'}, videoUrl: VIDEO_URL, durationSeconds: 12},
      {_id: 'drafts.lesson-selectors', _type: 'lesson', title: 'Draft selectors', slug: {_type: 'slug', current: 'draft-selectors'}, videoUrl: VIDEO_URL},
      {_id: video.documentId, _type: 'video', videoId: video.videoId, chapters: [], transcriptChunks: TRANSCRIPT},
      index as unknown as Doc,
      decoy(`drafts.${index._id}`, 'draftOnlySelector'),
      decoy(`versions.r1.${index._id}`, 'releaseOnlySelector'),
      // A published index that points at a draft video must not ground to the lesson.
      {_id: `drafts.${video.documentId}`, _type: 'video', videoId: video.videoId, chapters: [], transcriptChunks: []},
      {...decoy('visual-draft-video-ref', 'draftVideoSelector'), video: {_type: 'reference', _ref: `drafts.${video.documentId}`}},
      {_id: 'progress-user-1', _type: 'progress', userId: 'user_1', lesson: {_type: 'reference', _ref: 'lesson-selectors'}},
    ]
  })

  after(async () => {
    if (dir) await rm(dir, {recursive: true, force: true})
  })

  /** The search pipeline minus interpretation and the network: query → scope → parse → rank → Zod. */
  async function search(query: string, {groqFilter = NEW_FILTER, docs = published(raw)} = {}) {
    const terms = fallbackTerms(query)
    const [lessonRows, videoRows, courseRows, lessonIndexRows, visualRows] = await Promise.all([
      run(buildLessonCandidatesQuery(terms), groqFilter, docs),
      run(buildVideoCandidatesQuery(terms), groqFilter, docs),
      run(buildCourseCandidatesQuery(terms), groqFilter, docs),
      run(LESSON_VIDEO_INDEX_QUERY, groqFilter, docs),
      run(buildVisualCandidatesQuery(terms), groqFilter, docs),
    ])
    const ranked = rankCandidates(
      terms,
      terms,
      [...parseLessonCandidates(lessonRows), ...parseCourseCandidates(courseRows)],
      parseVideoMomentCandidates(videoRows, lessonIndexRows, visualRows),
    )
    const response = searchResponseSchema.parse({
      query,
      results: ranked.slice(0, 10),
      total: ranked.length,
      courseCount: new Set(ranked.map((result) => result.course?.id).filter(Boolean)).size,
      nextCursor: null,
    })
    return {response, videoRows, visualRows}
  }

  it('returns an on-screen identifier absent from the transcript with its lesson, second, and ocr source', async () => {
    assert.ok(!TRANSCRIPT.some((chunk) => /selectvisibletodos/i.test(chunk.text)))
    const {response, videoRows} = await search('selectVisibleTodos')
    assert.deepEqual(videoRows, [], 'the transcript and chapters do not contain the identifier')
    assert.equal(response.total, 1)
    const [result] = response.results
    assert.equal(result.type, 'video')
    assert.ok(result.type === 'video')
    assert.equal(result.lessonId, 'lesson-selectors')
    assert.equal(result.startSeconds, 0)
    assert.equal(result.href, '/lessons/memoized-selectors?t=0')
    assert.equal(result.matchKind, 'ocr')
    assert.match(result.momentLabel, /selectVisibleTodos/)
    assert.equal(result.course?.id, 'course-state')
  })

  it('returns a VLM interpretation with its vlm source and frame second', async () => {
    const {response} = await search('highlighted')
    const [result] = response.results
    assert.ok(result?.type === 'video')
    assert.equal(result.matchKind, 'vlm')
    assert.equal(result.startSeconds, 4)
    assert.equal(result.lessonId, 'lesson-selectors')
  })

  it('finds nothing visual under the live (pre-change) groqFilter', async () => {
    const {response, visualRows} = await search('selectVisibleTodos', {groqFilter: LIVE_FILTER})
    assert.deepEqual(visualRows, [])
    assert.equal(response.total, 0)
  })

  it('never returns draft or release-version indexes or draft video references, even if the perspective failed', async () => {
    for (const identifier of ['draftOnlySelector', 'releaseOnlySelector', 'draftVideoSelector']) {
      assert.equal((await search(identifier)).response.total, 0, identifier)
      // Raw perspective: the rows come back, and the published-id guard drops them.
      const rawRun = await search(identifier, {docs: raw})
      assert.ok((rawRun.visualRows as unknown[]).length > 0, `${identifier} reached the parser`)
      assert.equal(rawRun.response.total, 0, identifier)
    }
  })

  it('keeps progress out of scope and bounds the visual payload', async () => {
    assert.equal(await run('count(*[_type == "progress"])', NEW_FILTER, raw), 0)
    // The real index plus the published decoy that points at a draft video.
    assert.equal(await run('count(*[_type == "videoVisualIndex"])', NEW_FILTER, published(raw)), 2)
    const {visualRows} = await search('selectVisibleTodos')
    for (const row of visualRows as Array<{visualMatches: Array<{lines: string[]}>}>) {
      assert.ok(!('chunks' in row))
      assert.ok(row.visualMatches.length <= MAX_MOMENTS_PER_VIDEO)
      for (const match of row.visualMatches) assert.ok(match.lines.length <= MAX_VISUAL_LINES)
    }
  })
})
