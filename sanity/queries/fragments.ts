/**
 * Reusable GROQ projection fragments. Keep projections minimal: pages display
 * stored data, and search retrieves only the fields it ranks on.
 */

export const imageFragment = /* groq */ `
  _type,
  alt,
  hotspot,
  crop,
  asset->{
    _id,
    url,
    metadata { lqip, dimensions { width, height, aspectRatio } }
  }
`

export const instructorSummaryFragment = /* groq */ `
  _id,
  name,
  "slug": slug.current,
  expertise,
  photo { ${imageFragment} }
`

export const categorySummaryFragment = /* groq */ `
  _id,
  title,
  "slug": slug.current
`

export const lessonSummaryFragment = /* groq */ `
  _id,
  title,
  "slug": slug.current,
  durationSeconds,
  freePreview,
  poster { ${imageFragment} }
`

/** Fields needed by catalog / course cards. */
export const courseCardFragment = /* groq */ `
  _id,
  title,
  "slug": slug.current,
  summary,
  level,
  priceDisplay,
  popular,
  studentCountDisplay,
  coverImage { ${imageFragment} },
  instructor->{ ${instructorSummaryFragment} },
  category->{ ${categorySummaryFragment} },
  "moduleCount": count(modules),
  "lessonCount": count(modules[].lessons[]),
  "durationSeconds": math::sum(modules[].lessons[]->durationSeconds)
`
