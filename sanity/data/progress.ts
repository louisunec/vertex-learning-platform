import 'server-only'

import {sanityFetch} from '../lib/fetch'
import {PROGRESS_FOR_LESSON_QUERY, PROGRESS_FOR_USER_QUERY} from '../queries/progress'

/**
 * Learner-state reads are per-request (no cache) and keyed by the Clerk user
 * id resolved on the server (`auth()` / `currentUser()`), never by a value
 * from the browser.
 */
export function getProgressForUser(userId: string) {
  return sanityFetch({query: PROGRESS_FOR_USER_QUERY, params: {userId}, revalidate: 0})
}

export function getLessonProgress(userId: string, lessonId: string) {
  return sanityFetch({query: PROGRESS_FOR_LESSON_QUERY, params: {userId, lessonId}, revalidate: 0})
}
