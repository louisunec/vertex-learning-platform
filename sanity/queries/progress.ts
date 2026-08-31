import {defineQuery} from 'next-sanity'

/**
 * Learner progress reads. `$userId` must always be the Clerk user id resolved
 * on the server — never a value supplied by the browser.
 */
export const PROGRESS_FOR_USER_QUERY = defineQuery(/* groq */ `
  *[_type == "progress" && userId == $userId] | order(updatedAt desc) {
    _id,
    "lessonId": lesson._ref,
    completed,
    completedAt,
    resumeSeconds,
    updatedAt
  }
`)

export const PROGRESS_FOR_LESSON_QUERY = defineQuery(/* groq */ `
  *[_type == "progress" && userId == $userId && lesson._ref == $lessonId][0] {
    _id,
    "lessonId": lesson._ref,
    completed,
    completedAt,
    resumeSeconds,
    updatedAt
  }
`)
