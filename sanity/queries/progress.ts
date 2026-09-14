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

/** The published lesson a progress write targets; its duration bounds the position. */
export const PROGRESS_TARGET_LESSON_QUERY = defineQuery(/* groq */ `
  *[_type == "lesson" && _id == $lessonId && !(_id in path("drafts.**")) && !(_id in path("versions.**"))][0] {
    _id,
    durationSeconds
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
