import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {
  progressDocumentId,
  saveProgress,
  saveProgressRequestSchema,
  type ProgressLesson,
  type ProgressStore,
  type ProgressWrite,
} from './save.ts'

/** In-memory store that applies writes with the same semantics as the Sanity transaction. */
function memoryStore(lessons: ProgressLesson[]) {
  const rows = new Map<string, {userId: string; lessonId: string; resumeSeconds: number; completed: boolean; completedAt: string | null; updatedAt: string}>()
  const writes: ProgressWrite[] = []
  const store: ProgressStore = {
    async loadPublishedLesson(lessonId) {
      return lessons.find((lesson) => lesson._id === lessonId) ?? null
    },
    async write(w) {
      writes.push(w)
      const row = rows.get(w.documentId) ?? {userId: w.userId, lessonId: w.lessonId, resumeSeconds: 0, completed: false, completedAt: null, updatedAt: w.at}
      row.resumeSeconds = w.resumeSeconds
      row.updatedAt = w.at
      if (w.markCompleted) {
        row.completed = true
        row.completedAt ??= w.at
      }
      rows.set(w.documentId, row)
    },
  }
  return {store, rows, writes}
}

const LESSON = {_id: 'lesson.ml-gradient-descent', durationSeconds: 900}
const at = (minute: number) => new Date(Date.UTC(2026, 8, 13, 12, minute))

describe('saveProgressRequestSchema', () => {
  it('accepts a published lesson id and a position', () => {
    assert.ok(saveProgressRequestSchema.safeParse({lessonId: LESSON._id, positionSeconds: 522.4}).success)
  })

  it('rejects draft or version ids, unknown fields, and out-of-range positions', () => {
    for (const body of [
      {lessonId: 'drafts.lesson.x', positionSeconds: 1},
      {lessonId: 'versions.r1.lesson.x', positionSeconds: 1},
      {lessonId: '../lesson', positionSeconds: 1},
      {lessonId: LESSON._id, positionSeconds: -1},
      {lessonId: LESSON._id, positionSeconds: Number.POSITIVE_INFINITY},
      {lessonId: LESSON._id, positionSeconds: 1, userId: 'user_other'},
      {lessonId: LESSON._id, positionSeconds: 1, completed: 'yes'},
    ]) {
      assert.equal(saveProgressRequestSchema.safeParse(body).success, false, JSON.stringify(body))
    }
  })
})

describe('saveProgress', () => {
  it('returns not_found for a lesson that is not published, without writing', async () => {
    const {store, writes} = memoryStore([LESSON])
    const outcome = await saveProgress({store, userId: 'user_a', request: {lessonId: 'lesson.gone', positionSeconds: 5}, now: at(0)})
    assert.deepEqual(outcome, {status: 'not_found'})
    assert.equal(writes.length, 0)
  })

  it('floors the position and clamps it to the stored duration', async () => {
    const {store, writes} = memoryStore([LESSON])
    await saveProgress({store, userId: 'user_a', request: {lessonId: LESSON._id, positionSeconds: 522.9}, now: at(0)})
    await saveProgress({store, userId: 'user_a', request: {lessonId: LESSON._id, positionSeconds: 5000}, now: at(1)})
    assert.deepEqual(writes.map((w) => w.resumeSeconds), [522, 900])
  })

  it('updates one row per learner and lesson, and never clears completion', async () => {
    const {store, rows} = memoryStore([LESSON])
    const save = (positionSeconds: number, completed: boolean | undefined, minute: number) =>
      saveProgress({store, userId: 'user_a', request: {lessonId: LESSON._id, positionSeconds, completed}, now: at(minute)})
    await save(100, undefined, 0)
    await save(850, true, 5)
    await save(30, false, 9)
    assert.equal(rows.size, 1)
    const row = [...rows.values()][0]
    assert.equal(row.completed, true)
    assert.equal(row.completedAt, at(5).toISOString())
    assert.equal(row.resumeSeconds, 30)
    assert.equal(row.updatedAt, at(9).toISOString())
  })

  it('keeps learners apart with stable, dot-free document ids', () => {
    const a = progressDocumentId('user_a', LESSON._id)
    assert.equal(a, progressDocumentId('user_a', LESSON._id))
    assert.notEqual(a, progressDocumentId('user_b', LESSON._id))
    assert.match(a, /^progress-[0-9a-f]{32}$/)
  })
})
