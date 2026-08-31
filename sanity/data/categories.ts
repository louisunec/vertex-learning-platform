import 'server-only'

import {cacheTags, sanityFetch} from '../lib/fetch'
import {CATEGORIES_QUERY, CATEGORY_BY_SLUG_QUERY} from '../queries/categories'

const tags = [cacheTags.category, cacheTags.course]

export function getCategories() {
  return sanityFetch({query: CATEGORIES_QUERY, tags})
}

export function getCategoryBySlug(slug: string) {
  return sanityFetch({query: CATEGORY_BY_SLUG_QUERY, params: {slug}, tags})
}
