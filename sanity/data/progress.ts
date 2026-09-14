import 'server-only'

import {learnerStateClient} from '../lib/learner-client'
import {PROGRESS_FOR_LESSON_QUERY, PROGRESS_FOR_USER_QUERY} from '../queries/progress'

/**
 * Learner-state reads are per-request (no Next cache, no API CDN) and keyed
 * by the Clerk user id resolved on the server (`auth()` / `currentUser()`),
 * never by a value from the browser.
 */
export function getProgressForUser(userId: string) {
  return learnerStateClient.fetch(PROGRESS_FOR_USER_QUERY, {userId}, {next: {revalidate: 0}})
}

export function getLessonProgress(userId: string, lessonId: string) {
  return learnerStateClient.fetch(PROGRESS_FOR_LESSON_QUERY, {userId, lessonId}, {next: {revalidate: 0}})
}
