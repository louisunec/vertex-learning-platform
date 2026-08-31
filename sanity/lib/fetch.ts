import 'server-only'

import type {QueryParams} from 'next-sanity'

import {client} from './client'

/** Default time-based revalidation for authored content (seconds). */
export const CONTENT_REVALIDATE_SECONDS = 60

/** Tags used for on-demand revalidation (`revalidateTag`) by document type. */
export const cacheTags = {
  course: 'sanity:course',
  lesson: 'sanity:lesson',
  instructor: 'sanity:instructor',
  category: 'sanity:category',
  video: 'sanity:video',
} as const

type SanityFetchOptions<QueryString extends string> = {
  query: QueryString
  params?: QueryParams
  /** Cache tags for on-demand revalidation. */
  tags?: string[]
  /** Seconds before revalidation. Use `0` for per-request, uncached reads (learner state). */
  revalidate?: number
}

/**
 * Typed GROQ fetch for Server Components and route handlers.
 * Query result types come from Sanity TypeGen (`sanity.types.ts`).
 */
export async function sanityFetch<const QueryString extends string>({
  query,
  params = {},
  tags = [],
  revalidate = CONTENT_REVALIDATE_SECONDS,
}: SanityFetchOptions<QueryString>) {
  return client.fetch(query, params, {
    next: {revalidate, tags},
  })
}
