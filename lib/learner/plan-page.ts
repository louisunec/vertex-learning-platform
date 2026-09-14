import 'server-only'

import {getDb} from '@/lib/db/client'
import {nextActionCapabilities} from '@/lib/flags'

import {ContentUnavailableError} from './content-source'
import {planNextActions, type NextActionCapabilities} from './next-action'
import {sanityNextActionContent} from './next-action-content'
import type {NextActionResponse} from './next-action-contracts'
import type {CourseOption} from './next-action-source'

/**
 * Server-side reads for the pages that show next actions (`/learn` and My
 * Learning), through the same service as `POST /api/next`. Call only once
 * `isNextActionEnabled` is true. A failure is reported as such, by source,
 * and is never shown as an empty plan.
 */

export type PlanState =
  | {status: 'ready'; body: NextActionResponse}
  | {status: 'not_configured'}
  | {status: 'error'; source: 'content' | 'learner_data'}

/** `capabilities`, when the caller already evaluated them, spares a second round of flag reads. */
export async function loadPlan(userId: string, capabilities?: NextActionCapabilities): Promise<PlanState> {
  if (!process.env.DATABASE_URL?.trim()) {
    console.error('[next-action] enabled but DATABASE_URL is not set')
    return {status: 'not_configured'}
  }
  try {
    const outcome = await planNextActions({
      db: getDb(),
      content: sanityNextActionContent,
      learnerId: userId,
      request: {},
      capabilities: capabilities ?? (await nextActionCapabilities(userId)),
      now: new Date(),
    })
    // Without a requested course, the service never rejects.
    if (outcome.status !== 'ok') return {status: 'error', source: 'content'}
    return {status: 'ready', body: outcome.body}
  } catch (error) {
    const source = error instanceof ContentUnavailableError ? 'content' : 'learner_data'
    console.error(`[next-action] plan read failed (${source}):`, error instanceof Error ? error.message : error)
    return {status: 'error', source}
  }
}

/** Published courses to choose a goal from, or null when they can't be read. */
export async function loadGoalCourses(): Promise<CourseOption[] | null> {
  try {
    return await sanityNextActionContent.loadGoalCourses()
  } catch (error) {
    console.error('[next-action] goal courses read failed:', error instanceof Error ? error.message : error)
    return null
  }
}
