import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {summarizeCourseProgress} from './course-progress.ts'

const modules = [
  {_key: 'm1', lessons: [{_id: 'a'}, {_id: 'b'}]},
  {_key: 'm2', lessons: [{_id: 'c'}, null, {_id: 'd'}]},
]

describe('summarizeCourseProgress', () => {
  it('starts at the first lesson with no progress', () => {
    const p = summarizeCourseProgress(modules, [])
    assert.equal(p.totalLessons, 4)
    assert.equal(p.percent, 0)
    assert.equal(p.hasProgress, false)
    assert.equal(p.resumeLessonId, 'a')
  })

  it('counts only completed lessons that belong to the course', () => {
    const p = summarizeCourseProgress(modules, [
      {lessonId: 'a', completed: true, resumeSeconds: null, updatedAt: '2026-01-01T00:00:00Z'},
      {lessonId: 'zzz', completed: true, resumeSeconds: null, updatedAt: '2026-01-02T00:00:00Z'},
    ])
    assert.equal(p.completedLessons, 1)
    assert.equal(p.percent, 25)
    assert.equal(p.hasProgress, true)
    assert.equal(p.resumeLessonId, 'b')
  })

  it('resumes the most recently touched incomplete lesson', () => {
    const p = summarizeCourseProgress(modules, [
      {lessonId: 'a', completed: true, resumeSeconds: null, updatedAt: '2026-01-01T00:00:00Z'},
      {lessonId: 'b', completed: false, resumeSeconds: 30, updatedAt: '2026-01-02T00:00:00Z'},
      {lessonId: 'd', completed: false, resumeSeconds: 90, updatedAt: '2026-01-03T00:00:00Z'},
    ])
    assert.equal(p.resumeLessonId, 'd')
  })

  it('falls back to the first lesson when everything is complete', () => {
    const rows = ['a', 'b', 'c', 'd'].map((id) => ({
      lessonId: id,
      completed: true,
      resumeSeconds: null,
      updatedAt: null,
    }))
    const p = summarizeCourseProgress(modules, rows)
    assert.equal(p.percent, 100)
    assert.equal(p.resumeLessonId, 'a')
  })

  it('handles a course with no modules', () => {
    const p = summarizeCourseProgress(null, null)
    assert.equal(p.totalLessons, 0)
    assert.equal(p.percent, 0)
    assert.equal(p.resumeLessonId, null)
  })
})
