import 'server-only'

import {cacheTags, CONTENT_REVALIDATE_SECONDS, sanityFetch} from '../lib/fetch'
import {ATTEMPT_FEEDBACK_QUERY} from '../queries/assessments'
import {
  CONCEPT_IDS_FOR_LESSONS_QUERY,
  KNOWLEDGE_MAP_CONCEPTS_QUERY,
  KNOWLEDGE_MAP_EDGES_QUERY,
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

export function getKnowledgeMapConcepts(lessonIds: string[]) {
  return sanityFetch({
    query: KNOWLEDGE_MAP_CONCEPTS_QUERY,
    params: {lessonIds},
    revalidate: CONTENT_REVALIDATE_SECONDS,
  })
}

export function getKnowledgeMapEdges(conceptIds: string[]) {
  return sanityFetch({
    query: KNOWLEDGE_MAP_EDGES_QUERY,
    params: {conceptIds},
    revalidate: CONTENT_REVALIDATE_SECONDS,
  })
}

/**
 * SERVER-ONLY: answer-key reasons for already-answered assessments. Uncached,
 * so a withdrawn version stops showing at once; never pass the result to a
 * client component.
 */
export function getAttemptFeedback(assessmentIds: string[]) {
  return sanityFetch({query: ATTEMPT_FEEDBACK_QUERY, params: {assessmentIds}, revalidate: 0})
}
