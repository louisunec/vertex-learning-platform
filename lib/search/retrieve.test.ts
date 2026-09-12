import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {parseCourseCandidates, parseLessonCandidates, parseVideoMomentCandidates} from './retrieve.ts'

const VIDEO_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
const VIDEO_ID = 'youtube-dQw4w9WgXcQ'

const lessonRow = (id: string) => ({_id: id, title: 'React hooks', slug: 'react-hooks'})
const indexRow = (id: string, videoUrl = VIDEO_URL) => ({_id: id, _type: 'lesson', title: 'React hooks', slug: 'react-hooks', videoUrl})
const videoRow = (overrides: Record<string, unknown> = {}) => ({
  _id: `video-${VIDEO_ID}`,
  videoId: VIDEO_ID,
  chapterMatches: [{startSeconds: 42, label: 'useState'}],
  ...overrides,
})

describe('published-only retrieval', () => {
  it('drops draft and release-version lesson rows', () => {
    const candidates = parseLessonCandidates([
      lessonRow('lesson-1'),
      lessonRow('drafts.lesson-1'),
      lessonRow('versions.r123.lesson-1'),
    ])
    assert.deepEqual(
      candidates.map((c) => c.lessonId),
      ['lesson-1'],
    )
  })

  it('drops draft course rows', () => {
    const course = (id: string) => ({
      _id: id,
      title: 'React',
      slug: 'react',
      modules: [{_key: 'm1', title: 'Basics', lessons: [lessonRow('lesson-1')]}],
    })
    assert.equal(parseCourseCandidates([course('drafts.course-1')]).length, 0)
    assert.equal(parseCourseCandidates([course('course-1')]).length, 1)
  })

  it('drops course rows whose nested lesson is a draft or release version', () => {
    const course = (lessonId: string) => ({
      _id: 'course-1',
      title: 'React',
      slug: 'react',
      modules: [{_key: 'm1', title: 'Basics', lessons: [lessonRow(lessonId)]}],
    })
    for (const id of ['drafts.lesson-1', 'versions.r123.lesson-1']) {
      assert.equal(parseCourseCandidates([course(id)]).length, 0, id)
    }
    assert.deepEqual(
      parseCourseCandidates([course('lesson-1')]).map((c) => c.lessonId),
      ['lesson-1'],
    )
  })

  it('drops lesson and video-index rows whose nested course is a draft or release version', () => {
    const nestedCourse = (id: string) => ({
      _id: id,
      title: 'React',
      slug: 'react',
      modules: [{_key: 'm1', title: 'Basics', lessonIds: ['lesson-1']}],
    })
    for (const id of ['drafts.course-1', 'versions.r123.course-1']) {
      assert.equal(parseLessonCandidates([{...lessonRow('lesson-1'), course: nestedCourse(id)}]).length, 0, id)
      assert.equal(
        parseVideoMomentCandidates([videoRow()], [{...indexRow('lesson-1'), course: nestedCourse(id)}]).length,
        0,
        id,
      )
    }
    const [lesson] = parseLessonCandidates([{...lessonRow('lesson-1'), course: nestedCourse('course-1')}])
    assert.equal(lesson.course?.id, 'course-1')
    const [moment] = parseVideoMomentCandidates([videoRow()], [{...indexRow('lesson-1'), course: nestedCourse('course-1')}])
    assert.equal(moment.course?.id, 'course-1')
  })

  it('drops draft video rows and never grounds a moment to a draft lesson', () => {
    assert.equal(parseVideoMomentCandidates([videoRow({_id: `drafts.video-${VIDEO_ID}`})], [indexRow('lesson-1')]).length, 0)
    assert.equal(parseVideoMomentCandidates([videoRow()], [indexRow('drafts.lesson-1')]).length, 0)
  })
})

describe('video moment grounding', () => {
  it('ties a moment to the lesson that uses the video', () => {
    const [moment] = parseVideoMomentCandidates([videoRow()], [indexRow('lesson-1')])
    assert.equal(moment.lessonId, 'lesson-1')
    assert.equal(moment.startSeconds, 42)
    assert.equal(moment.matchKind, 'chapter')
  })

  it('drops videos no lesson uses', () => {
    const otherLesson = indexRow('lesson-2', 'https://www.youtube.com/watch?v=aaaaaaaaaaa')
    assert.equal(parseVideoMomentCandidates([videoRow()], [otherLesson]).length, 0)
    assert.equal(parseVideoMomentCandidates([videoRow()], []).length, 0)
  })

  it('drops rows with invalid timestamps instead of repairing them', () => {
    for (const startSeconds of [-5, 1.5, '42', null]) {
      const row = videoRow({chapterMatches: [{startSeconds, label: 'useState'}]})
      assert.equal(parseVideoMomentCandidates([row], [indexRow('lesson-1')]).length, 0, String(startSeconds))
    }
  })

  it('bounds transcript fallback snippets', () => {
    const row = videoRow({chapterMatches: [], transcriptMatches: [{startSeconds: 10, text: 'x'.repeat(500)}]})
    const [moment] = parseVideoMomentCandidates([row], [indexRow('lesson-1')])
    assert.equal(moment.matchKind, 'transcript')
    assert.ok(moment.momentText.length <= 141)
  })
})

describe('visual moment grounding', () => {
  const visualRow = (overrides: Record<string, unknown> = {}) => ({
    _id: `visual-video-${VIDEO_ID}`,
    _type: 'videoVisualIndex',
    video: {_id: `video-${VIDEO_ID}`, _type: 'video', videoId: VIDEO_ID},
    visualMatches: [
      {startSeconds: 12, source: 'ocr', lines: ['const selectVisibleTodos = createSelector(']},
      {startSeconds: 30, source: 'vlm', lines: ['Component tree with a highlighted leaf']},
    ],
    ...overrides,
  })
  const ground = (row: unknown, lessons: unknown[] = [indexRow('lesson-1')]) => parseVideoMomentCandidates([], lessons, [row])
  const noChapters = videoRow({chapterMatches: [], transcriptMatches: []})

  it('ties OCR and VLM matches to the lesson that uses the video, keeping their source', () => {
    assert.deepEqual(
      ground(visualRow()).map((m) => [m.lessonId, m.startSeconds, m.matchKind, m.momentText]),
      [
        ['lesson-1', 12, 'ocr', 'const selectVisibleTodos = createSelector('],
        ['lesson-1', 30, 'vlm', 'Component tree with a highlighted leaf'],
      ],
    )
  })

  it('accepts only videoVisualIndex rows', () => {
    for (const _type of ['video', 'progress', 'lesson', undefined]) {
      assert.equal(ground(visualRow({_type})).length, 0, String(_type))
    }
  })

  it('drops draft and release-version visual rows', () => {
    for (const _id of [`drafts.visual-video-${VIDEO_ID}`, `versions.r1.visual-video-${VIDEO_ID}`]) {
      assert.equal(ground(visualRow({_id})).length, 0, _id)
    }
  })

  it('drops rows whose referenced video is a draft, a release version, another type, missing, or mismatched', () => {
    const videos = [
      {_id: `drafts.video-${VIDEO_ID}`, _type: 'video', videoId: VIDEO_ID},
      {_id: `versions.r1.video-${VIDEO_ID}`, _type: 'video', videoId: VIDEO_ID},
      {_id: `video-${VIDEO_ID}`, _type: 'lesson', videoId: VIDEO_ID},
      {_id: `video-youtube-other`, _type: 'video', videoId: VIDEO_ID},
      {_id: `video-${VIDEO_ID}`, _type: 'video', videoId: ''},
      null,
    ]
    for (const video of videos) assert.equal(ground(visualRow({video})).length, 0, JSON.stringify(video))
  })

  it('grounds only to published lesson rows of type lesson, and drops unresolved videos', () => {
    assert.equal(ground(visualRow(), [indexRow('drafts.lesson-1')]).length, 0)
    assert.equal(ground(visualRow(), [indexRow('versions.r1.lesson-1')]).length, 0)
    assert.equal(ground(visualRow(), [{...indexRow('lesson-1'), _type: 'course'}]).length, 0)
    const other = {_id: 'video-youtube-other', _type: 'video', videoId: 'youtube-other'}
    assert.equal(ground(visualRow({video: other})).length, 0)
  })

  it('lets a chapter match on the same video suppress visual fallbacks', () => {
    const moments = parseVideoMomentCandidates([videoRow()], [indexRow('lesson-1')], [visualRow()])
    assert.deepEqual(
      moments.map((m) => m.matchKind),
      ['chapter'],
    )
    assert.equal(parseVideoMomentCandidates([noChapters], [indexRow('lesson-1')], [visualRow()]).length, 2)
  })

  it('drops the whole row when any match is malformed, never keeping the valid part', () => {
    const valid = {startSeconds: 12, source: 'ocr', lines: ['const selectVisibleTodos = 1']}
    const malformed = [
      {startSeconds: 1, source: 'transcript', lines: ['x']},
      {startSeconds: 1, source: 'chapter', lines: ['x']},
      {startSeconds: 1.5, source: 'ocr', lines: ['x']},
      {startSeconds: -1, source: 'ocr', lines: ['x']},
      {startSeconds: 1, source: 'ocr'},
      {startSeconds: 1, source: 'ocr', lines: null},
      {startSeconds: 1, source: 'ocr', lines: []},
      {startSeconds: 1, source: 'ocr', lines: ['a', 'b', 'c']},
      {startSeconds: 1, source: 'ocr', lines: [42]},
    ]
    for (const match of malformed) {
      assert.equal(ground(visualRow({visualMatches: [valid, match]})).length, 0, JSON.stringify(match))
    }
    assert.equal(ground(visualRow({visualMatches: null})).length, 0)
    assert.equal(ground(visualRow({visualMatches: Array(7).fill(valid)})).length, 0, 'more matches than the query allows')
  })

  it('drops blank snippets and bounds long lines', () => {
    assert.equal(ground(visualRow({visualMatches: [{startSeconds: 1, source: 'ocr', lines: ['  ']}]})).length, 0)
    const [long] = ground(visualRow({visualMatches: [{startSeconds: 1, source: 'ocr', lines: ['y'.repeat(300), 'z'.repeat(300)]}]}))
    assert.ok(long.momentText.length <= 141)
  })
})
