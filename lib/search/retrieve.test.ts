import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {parseCourseCandidates, parseLessonCandidates, parseVideoMomentCandidates} from './retrieve.ts'

const VIDEO_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
const VIDEO_ID = 'youtube-dQw4w9WgXcQ'

const lessonRow = (id: string) => ({_id: id, title: 'React hooks', slug: 'react-hooks'})
const indexRow = (id: string, videoUrl = VIDEO_URL) => ({_id: id, title: 'React hooks', slug: 'react-hooks', videoUrl})
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
