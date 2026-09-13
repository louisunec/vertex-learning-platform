import {createHash} from 'node:crypto'

import {z} from 'zod'

/**
 * Saving learner progress (resume position and completion) for one lesson.
 * Framework-free: the route supplies the Clerk user id from `auth()` and a
 * store backed by Sanity; tests supply a fake store.
 *
 * - The lesson must be a published lesson; its stored duration bounds the position.
 * - `completed` is only ever set, never cleared, so a later partial replay
 *   of a finished lesson cannot undo completion.
 * - One document per learner and lesson (deterministic id), so repeated
 *   saves update the same row instead of adding rows.
 */

export const MAX_PROGRESS_BODY_BYTES = 1024

/** Published Sanity document id: no draft or release version, no path traversal. */
const LESSON_ID = /^(?!drafts\.|versions\.)[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** Upper bound when a lesson has no stored duration (one day). */
const MAX_POSITION_SECONDS = 86_400

export const saveProgressRequestSchema = z.strictObject({
  lessonId: z.string().regex(LESSON_ID),
  positionSeconds: z.number().finite().min(0).max(MAX_POSITION_SECONDS),
  completed: z.boolean().optional(),
})

export type SaveProgressRequest = z.infer<typeof saveProgressRequestSchema>

export type ProgressLesson = {_id: string; durationSeconds: number | null}

export type ProgressWrite = {
  documentId: string
  userId: string
  lessonId: string
  resumeSeconds: number
  /** Only `true` is ever written. */
  markCompleted: boolean
  /** ISO timestamp; `updatedAt`, and `completedAt` when first completed. */
  at: string
}

export type ProgressStore = {
  loadPublishedLesson(lessonId: string): Promise<ProgressLesson | null>
  write(progress: ProgressWrite): Promise<void>
}

export type SaveProgressOutcome =
  /** `markedCompleted` says whether this save completed the lesson; completion is never cleared. */
  | {status: 'saved'; lessonId: string; resumeSeconds: number; markedCompleted: boolean}
  | {status: 'not_found'}

/** Stable, dot-free document id for one learner's progress on one lesson. */
export function progressDocumentId(userId: string, lessonId: string): string {
  return `progress-${createHash('sha256').update(`${userId}\n${lessonId}`).digest('hex').slice(0, 32)}`
}

export async function saveProgress({
  store,
  userId,
  request,
  now,
}: {
  store: ProgressStore
  userId: string
  request: SaveProgressRequest
  now: Date
}): Promise<SaveProgressOutcome> {
  if (!userId) throw new Error('A learner id is required')
  const lesson = await store.loadPublishedLesson(request.lessonId)
  if (!lesson) return {status: 'not_found'}

  const limit = lesson.durationSeconds && lesson.durationSeconds > 0 ? lesson.durationSeconds : MAX_POSITION_SECONDS
  const resumeSeconds = Math.floor(Math.min(request.positionSeconds, limit))
  const markCompleted = request.completed === true

  await store.write({
    documentId: progressDocumentId(userId, lesson._id),
    userId,
    lessonId: lesson._id,
    resumeSeconds,
    markCompleted,
    at: now.toISOString(),
  })
  return {status: 'saved', lessonId: lesson._id, resumeSeconds, markedCompleted: markCompleted}
}
