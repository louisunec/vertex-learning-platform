import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {rankCandidates} from './rank.ts'
import type {LessonCandidate, VideoMomentCandidate} from './retrieve.ts'

function lesson(overrides: Partial<LessonCandidate> & {lessonId: string; title: string}): LessonCandidate {
  return {
    slug: overrides.lessonId,
    durationSeconds: null,
    freePreview: null,
    posterUrl: null,
    keyPoints: [],
    proTip: null,
    notesHits: [],
    course: null,
    courseSummary: null,
    broad: false,
    courseMatchText: null,
    ...overrides,
  }
}

function moment(
  overrides: Partial<VideoMomentCandidate> & {lessonId: string; startSeconds: number; momentText: string},
): VideoMomentCandidate {
  return {
    title: `Lesson ${overrides.lessonId}`,
    slug: overrides.lessonId,
    durationSeconds: null,
    freePreview: null,
    posterUrl: null,
    course: null,
    matchKind: 'chapter',
    ...overrides,
  }
}

const terms = ['css', 'grid']

describe('rankCandidates', () => {
  it('ranks a specific title match above a broad course-level match', () => {
    const results = rankCandidates(
      terms,
      terms,
      [
        lesson({lessonId: 'broad', title: 'Introduction', broad: true, courseMatchText: 'CSS for beginners'}),
        lesson({lessonId: 'specific', title: 'CSS Grid fundamentals'}),
      ],
      [],
    )
    assert.deepEqual(
      results.map((r) => r.lessonId),
      ['specific', 'broad'],
    )
  })

  it('ranks a chapter match above a transcript fallback', () => {
    const results = rankCandidates(
      terms,
      terms,
      [],
      [
        moment({lessonId: 'a', startSeconds: 10, momentText: 'css grid areas', matchKind: 'transcript'}),
        moment({lessonId: 'b', startSeconds: 20, momentText: 'css grid areas', matchKind: 'chapter'}),
      ],
    )
    assert.deepEqual(
      results.map((r) => r.lessonId),
      ['b', 'a'],
    )
  })

  it('keeps transcript fallback moments when no chapter matched', () => {
    const results = rankCandidates(terms, terms, [], [
      moment({lessonId: 'a', startSeconds: 42, momentText: 'using css grid here', matchKind: 'transcript'}),
    ])
    assert.equal(results.length, 1)
    assert.equal(results[0].type, 'video')
    assert.equal(results[0].href, '/lessons/a?t=42')
  })

  it('preserves the real timestamp in the navigation target', () => {
    const [result] = rankCandidates(terms, terms, [], [
      moment({lessonId: 'x', slug: 'grid-lesson', startSeconds: 754, momentText: 'grid template columns'}),
    ])
    assert.equal(result.type, 'video')
    assert.equal(result.href, '/lessons/grid-lesson?t=754')
    assert.equal((result as {startSeconds: number}).startSeconds, 754)
  })

  it('deduplicates lessons matched both directly and through their course', () => {
    const results = rankCandidates(
      terms,
      terms,
      [
        lesson({lessonId: 'dup', title: 'CSS Grid'}),
        lesson({lessonId: 'dup', title: 'CSS Grid', broad: true, courseMatchText: 'css layout course'}),
      ],
      [],
    )
    assert.equal(results.filter((r) => r.lessonId === 'dup').length, 1)
  })

  it('deduplicates identical video moments and caps moments per lesson', () => {
    const moments = [0, 0, 30, 60, 90, 120].map((t) =>
      moment({lessonId: 'v', startSeconds: t, momentText: 'css grid chapter'}),
    )
    const results = rankCandidates(terms, terms, [], moments)
    assert.equal(results.length, 3)
    assert.equal(new Set(results.map((r) => r.href)).size, 3)
  })

  it('drops candidates with no confirmable term hits instead of padding results', () => {
    const results = rankCandidates(terms, terms, [lesson({lessonId: 'noise', title: 'Watercolor painting'})], [])
    assert.deepEqual(results, [])
  })

  it('all-term title matches outrank single-term title matches', () => {
    const results = rankCandidates(
      terms,
      terms,
      [
        lesson({lessonId: 'partial', title: 'Grid systems in print design'}),
        lesson({lessonId: 'exact', title: 'CSS Grid layout'}),
      ],
      [],
    )
    assert.deepEqual(
      results.map((r) => r.lessonId),
      ['exact', 'partial'],
    )
  })

  it('scores LLM expansion terms below the learner’s own terms', () => {
    // Query "css grid" expanded with "flexbox": the synonym must not let a
    // flexbox lesson outrank (or tie) the specific css-grid title match.
    const allTerms = ['css', 'grid', 'flexbox']
    const primary = ['css', 'grid']
    const results = rankCandidates(
      allTerms,
      primary,
      [
        lesson({lessonId: 'expansion', title: 'Flexbox basics'}),
        lesson({lessonId: 'specific', title: 'CSS Grid layout'}),
      ],
      [],
    )
    assert.deepEqual(
      results.map((r) => r.lessonId),
      ['specific', 'expansion'],
    )
  })

  it('is deterministic for tied scores (stable title tie-break)', () => {
    const a = lesson({lessonId: 'a1', title: 'Grid basics'})
    const b = lesson({lessonId: 'b1', title: 'Another grid intro'})
    const forward = rankCandidates(terms, terms, [a, b], [])
    const reversed = rankCandidates(terms, terms, [b, a], [])
    assert.deepEqual(
      forward.map((r) => r.lessonId),
      reversed.map((r) => r.lessonId),
    )
  })
})
