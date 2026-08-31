import {defineQuery} from 'next-sanity'

import {courseCardFragment, instructorSummaryFragment} from './fragments'

export const INSTRUCTORS_QUERY = defineQuery(/* groq */ `
  *[_type == "instructor" && defined(slug.current)] | order(name asc) {
    ${instructorSummaryFragment},
    "courseCount": count(*[_type == "course" && instructor._ref == ^._id])
  }
`)

export const INSTRUCTOR_BY_SLUG_QUERY = defineQuery(/* groq */ `
  *[_type == "instructor" && slug.current == $slug][0] {
    ${instructorSummaryFragment},
    bio,
    "courses": *[_type == "course" && instructor._ref == ^._id && defined(slug.current)]
      | order(title asc) { ${courseCardFragment} }
  }
`)
