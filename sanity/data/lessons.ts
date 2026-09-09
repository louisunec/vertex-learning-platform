import 'server-only'

import {findLessonContext} from '../lib/curriculum'
import {cacheTags, sanityFetch} from '../lib/fetch'
import {LESSON_BY_SLUG_QUERY, LESSON_SLUGS_QUERY} from '../queries/lessons'

const tags = [cacheTags.lesson, cacheTags.course, cacheTags.instructor]

export function getLessonSlugs() {
  return sanityFetch({query: LESSON_SLUGS_QUERY, tags: [cacheTags.lesson]})
}

/**
 * Lesson plus its derived course context. `context` is `null` when no course
 * references the lesson (the page should degrade, not fabricate a course).
 */
export async function getLessonBySlug(slug: string) {
  const lesson = await sanityFetch({query: LESSON_BY_SLUG_QUERY, params: {slug}, tags})
  if (!lesson) return null
  const context = lesson.course ? findLessonContext(lesson.course.modules, lesson._id) : null
  return {...lesson, context}
}
