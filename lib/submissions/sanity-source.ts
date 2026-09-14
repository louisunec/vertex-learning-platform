import 'server-only'

import {ContentUnavailableError} from '@/lib/learner/content-source'
import {sanityFetch} from '@/sanity/lib/fetch'

import {createGroqSubmissionTaskSource} from './source'

/**
 * Submission tasks through the published-perspective server client. Reads
 * are uncached, as for assessments, so a withdrawn or re-versioned task stops
 * being reviewed at once. A read failure is a retryable outage, never "no task".
 */
export const sanitySubmissionTaskSource = createGroqSubmissionTaskSource(async (query, params) => {
  try {
    return await sanityFetch({query, params, revalidate: 0})
  } catch (error) {
    throw new ContentUnavailableError('Submission task could not be read', {cause: error})
  }
})
