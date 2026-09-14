import 'server-only'

import {ContentUnavailableError} from '@/lib/learner/content-source'
import {sanityFetch} from '@/sanity/lib/fetch'

import {createGroqExplanationTaskSource} from './source'

/**
 * Explanation tasks through the published-perspective server client. Reads
 * are uncached, as for assessments, so a withdrawn or re-versioned task stops
 * being evaluated at once. A read failure is a retryable outage, never "no task".
 */
export const sanityExplanationTaskSource = createGroqExplanationTaskSource(async (query, params) => {
  try {
    return await sanityFetch({query, params, revalidate: 0})
  } catch (error) {
    throw new ContentUnavailableError('Explanation task could not be read', {cause: error})
  }
})
