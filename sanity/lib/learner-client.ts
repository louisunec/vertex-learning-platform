import 'server-only'

import {createClient, type SanityClient} from 'next-sanity'

import {apiVersion, dataset, projectId} from '../env'

/**
 * Server-only Sanity clients for learner state (`progress`). Both bypass the
 * API CDN so a learner sees the position they just saved. Never import from
 * a Client Component.
 */

/** Reads learner state with the app's read token. */
export const learnerStateClient = createClient({
  projectId,
  dataset,
  apiVersion,
  useCdn: false,
  perspective: 'published',
  stega: false,
  token: process.env.SANITY_API_READ_TOKEN,
})

export class ProgressWriterUnavailableError extends Error {
  constructor() {
    super('SANITY_API_PROGRESS_WRITE_TOKEN is not set')
    this.name = 'ProgressWriterUnavailableError'
  }
}

let writer: SanityClient | null = null

/**
 * Writes `progress` documents for `POST /api/progress` only. Uses its own
 * token, never the offline tooling token (`SANITY_API_WRITE_TOKEN`).
 */
export function getProgressWriteClient(): SanityClient {
  const token = process.env.SANITY_API_PROGRESS_WRITE_TOKEN?.trim()
  if (!token) throw new ProgressWriterUnavailableError()
  writer ??= createClient({projectId, dataset, apiVersion, useCdn: false, perspective: 'raw', stega: false, token})
  return writer
}
