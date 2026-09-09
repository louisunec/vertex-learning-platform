import 'server-only'

import {cacheTags, sanityFetch} from '../lib/fetch'
import {COURSE_BY_SLUG_QUERY, COURSE_SLUGS_QUERY, COURSES_QUERY} from '../queries/courses'

const tags = [cacheTags.course, cacheTags.lesson, cacheTags.instructor, cacheTags.category]

export function getCourses() {
  return sanityFetch({query: COURSES_QUERY, tags})
}

export function getCourseSlugs() {
  return sanityFetch({query: COURSE_SLUGS_QUERY, tags: [cacheTags.course]})
}

export function getCourseBySlug(slug: string) {
  return sanityFetch({query: COURSE_BY_SLUG_QUERY, params: {slug}, tags})
}
