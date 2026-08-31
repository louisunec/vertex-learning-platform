import 'server-only'

import {cacheTags, sanityFetch} from '../lib/fetch'
import {INSTRUCTOR_BY_SLUG_QUERY, INSTRUCTORS_QUERY} from '../queries/instructors'

const tags = [cacheTags.instructor, cacheTags.course]

export function getInstructors() {
  return sanityFetch({query: INSTRUCTORS_QUERY, tags})
}

export function getInstructorBySlug(slug: string) {
  return sanityFetch({query: INSTRUCTOR_BY_SLUG_QUERY, params: {slug}, tags})
}
