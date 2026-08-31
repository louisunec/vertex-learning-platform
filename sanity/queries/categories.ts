import {defineQuery} from 'next-sanity'

import {categorySummaryFragment, courseCardFragment} from './fragments'

export const CATEGORIES_QUERY = defineQuery(/* groq */ `
  *[_type == "category" && defined(slug.current)] | order(title asc) {
    ${categorySummaryFragment},
    description,
    "courseCount": count(*[_type == "course" && category._ref == ^._id])
  }
`)

export const CATEGORY_BY_SLUG_QUERY = defineQuery(/* groq */ `
  *[_type == "category" && slug.current == $slug][0] {
    ${categorySummaryFragment},
    description,
    "courses": *[_type == "course" && category._ref == ^._id && defined(slug.current)]
      | order(popular desc, title asc) { ${courseCardFragment} }
  }
`)
