import 'server-only'

import {cacheTags, CONTENT_REVALIDATE_SECONDS, sanityFetch} from '../lib/fetch'
import {
  CONCEPT_IDS_FOR_LESSONS_QUERY,
  LESSONS_BY_IDS_QUERY,
  MY_LEARNING_COURSES_QUERY,
} from '../queries/my-learning'

/** Authored content only; learner ids never reach these queries. */

export function getCoursesContainingLessons(lessonIds: string[]) {
  return sanityFetch({
    query: MY_LEARNING_COURSES_QUERY,
    params: {lessonIds},
    tags: [cacheTags.course, cacheTags.lesson],
  })
}

export function getLessonsByIds(lessonIds: string[]) {
  return sanityFetch({query: LESSONS_BY_IDS_QUERY, params: {lessonIds}, tags: [cacheTags.lesson]})
}

export function getConceptIdsForLessons(lessonIds: string[]) {
  return sanityFetch({
    query: CONCEPT_IDS_FOR_LESSONS_QUERY,
    params: {lessonIds},
    revalidate: CONTENT_REVALIDATE_SECONDS,
  })
}
