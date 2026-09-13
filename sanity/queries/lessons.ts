import {defineQuery} from 'next-sanity'

import {imageFragment, instructorSummaryFragment, lessonSummaryFragment} from './fragments'

/**
 * Lesson page data. The parent course is derived through the reverse
 * reference (the first published course whose modules reference this lesson);
 * it is `null` for a lesson no course uses.
 */
export const LESSON_BY_SLUG_QUERY = defineQuery(/* groq */ `
  *[_type == "lesson" && slug.current == $slug][0] {
    _id,
    _rev,
    title,
    "slug": slug.current,
    videoUrl,
    poster { ${imageFragment} },
    durationSeconds,
    freePreview,
    studentCountDisplay,
    notes,
    keyPoints,
    proTip,
    resources[] { _key, type, title, description, url },
    "course": *[_type == "course" && references(^._id)] | order(_createdAt asc)[0] {
      _id,
      title,
      "slug": slug.current,
      level,
      coverImage { ${imageFragment} },
      instructor->{ ${instructorSummaryFragment} },
      modules[] {
        _key,
        title,
        lessons[]->{ ${lessonSummaryFragment} }
      }
    }
  }
`)

export const LESSON_SLUGS_QUERY = defineQuery(/* groq */ `
  *[_type == "lesson" && defined(slug.current)].slug.current
`)
