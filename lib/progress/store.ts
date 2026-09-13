import 'server-only'

import {getProgressWriteClient, learnerStateClient} from '@/sanity/lib/learner-client'
import {PROGRESS_TARGET_LESSON_QUERY} from '@/sanity/queries/progress'

import type {ProgressStore} from './save'

/**
 * Sanity-backed progress store. The lesson check reads the published
 * perspective without the CDN; the write creates the learner's row once and
 * patches it in one transaction, so a save is all-or-nothing.
 */
export const sanityProgressStore: ProgressStore = {
  async loadPublishedLesson(lessonId) {
    const lesson = await learnerStateClient.fetch(PROGRESS_TARGET_LESSON_QUERY, {lessonId}, {next: {revalidate: 0}})
    return lesson ? {_id: lesson._id, durationSeconds: lesson.durationSeconds ?? null} : null
  },

  async write({documentId, userId, lessonId, resumeSeconds, markCompleted, at}) {
    await getProgressWriteClient()
      .transaction()
      .createIfNotExists({
        _id: documentId,
        _type: 'progress',
        userId,
        lesson: {_type: 'reference', _ref: lessonId},
        completed: false,
        resumeSeconds: 0,
        updatedAt: at,
      })
      .patch(documentId, (patch) => {
        const updated = patch.set({resumeSeconds, updatedAt: at})
        return markCompleted ? updated.set({completed: true}).setIfMissing({completedAt: at}) : updated
      })
      .commit({visibility: 'sync'})
  },
}
