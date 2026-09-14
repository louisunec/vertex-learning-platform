import 'server-only'

import {createClient} from 'next-sanity'

import {apiVersion, dataset, projectId} from '../env'

/**
 * Server-only read client. Never import this from a Client Component.
 *
 * `SANITY_API_READ_TOKEN` is optional while the dataset is public and required
 * once it is made private; it is read from the server environment only.
 */
export const client = createClient({
  projectId,
  dataset,
  apiVersion,
  useCdn: true,
  perspective: 'published',
  stega: false,
  token: process.env.SANITY_API_READ_TOKEN,
})

/**
 * Server-only, uncached raw reads that can see unpublished drafts (with the
 * read token). For display-only review aids such as the knowledge map's
 * AI-proposed edges; learner-facing decisions never read through it.
 */
export const draftReadClient = client.withConfig({useCdn: false, perspective: 'raw'})
