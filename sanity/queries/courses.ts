import {defineQuery} from 'next-sanity'

import {
  courseCardFragment,
  instructorSummaryFragment,
  lessonSummaryFragment,
} from './fragments'

export const COURSES_QUERY = defineQuery(/* groq */ `
  *[_type == "course" && defined(slug.current)]
    | order(popular desc, title asc) {
    ${courseCardFragment}
  }
`)

export const COURSE_SLUGS_QUERY = defineQuery(/* groq */ `
  *[_type == "course" && defined(slug.current)].slug.current
`)

export const COURSE_BY_SLUG_QUERY = defineQuery(/* groq */ `
  *[_type == "course" && slug.current == $slug][0] {
    ${courseCardFragment},
    instructor->{ ${instructorSummaryFragment}, bio },
    learningOutcomes[] { _key, icon, title, description },
    modules[] {
      _key,
      title,
      summary,
      lessons[]->{ ${lessonSummaryFragment} }
    }
  }
`)
