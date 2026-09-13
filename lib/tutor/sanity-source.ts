import 'server-only'

import {ContentUnavailableError} from '@/lib/learner/content-source'
import {cacheTags, CONTENT_REVALIDATE_SECONDS, sanityFetch} from '@/sanity/lib/fetch'

import {createGroqTutorSource} from './source'

/**
 * Tutor sources through the published-perspective server client. Lessons
 * and transcripts are authored content, so they use the normal content
 * revalidation; chunk ids carry revisions, so a changed chunk can never be
 * cited under an old one. A read failure is a retryable outage, never
 * "no evidence".
 */
export const sanityTutorSource = createGroqTutorSource(async (query, params) => {
  try {
    return await sanityFetch({
      query,
      params,
      revalidate: CONTENT_REVALIDATE_SECONDS,
      tags: [cacheTags.lesson, cacheTags.course, cacheTags.video],
    })
  } catch (error) {
    throw new ContentUnavailableError('Tutor sources could not be read', {cause: error})
  }
})
