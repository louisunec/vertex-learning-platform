import 'server-only'

import {getPostHogClient} from '@/lib/posthog-server'

/**
 * Server-side PostHog feature flags. Every AI-native increment ships behind a
 * flag that defaults to off (development plan §4). Evaluation fails closed:
 * missing configuration, errors, or timeouts all read as "off".
 */

export const FLAGS = {
  /** PR-0: route search query interpretation through `lib/ai/gateway`. */
  aiGatewaySearch: 'ai-gateway-search',
  /** PR-4: task instances, server grading, and learner evidence (`/api/task-instances`, `/api/attempts`). */
  learnerEvidence: 'learner-evidence',
  /** PR-5: the server-side help policy (`/api/help`). Requires `learner-evidence` too. */
  helpPolicy: 'help-policy',
  /** PR-6: the time-anchored tutor (`/api/tutor`). Requires `learner-evidence` and `help-policy` too. */
  tutor: 'tutor',
  /**
   * PR-7: the lesson-page tutor panel and understanding check (`/api/lesson-check`). The check
   * requires `learner-evidence`, its hints `help-policy`, and the panel all three flags above.
   */
  lessonIntegration: 'lesson-integration',
  /**
   * PR-10: the instrumentation behind editorial signals: `video_seeked` from the lesson player
   * (read in the browser from posthog-js, `lib/video/seek.ts`) and the server-side `search_outcome`
   * event (evaluated locally only, after the response). Roll it out by percentage without person or
   * cohort conditions, which local evaluation cannot match. The offline jobs (`npm run outbox`,
   * `npm run signals`) are not flag-gated; they run only when someone runs or schedules them.
   */
  editorialSignals: 'editorial-signals',
} as const

export type FlagKey = (typeof FLAGS)[keyof typeof FLAGS]

/**
 * Whether `key` is on for `distinctId` (Clerk user id or `"anonymous"`).
 *
 * `localOnly` never falls back to a remote `/flags` request: a flag missing
 * from the locally loaded definitions, one whose conditions cannot be
 * matched locally (person properties, cohorts, "persist across
 * authentication"), or a process without `POSTHOG_SECRET_KEY` reads as off.
 * Use it for analytics-only gates, which must not add PostHog traffic to
 * every request.
 */
export async function isFlagEnabled(key: FlagKey, distinctId: string, {localOnly = false}: {localOnly?: boolean} = {}): Promise<boolean> {
  if (!process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN) return false
  try {
    const flags = await getPostHogClient().evaluateFlags(distinctId, {flagKeys: [key], ...(localOnly ? {onlyEvaluateLocally: true} : {})})
    return flags.isEnabled(key)
  } catch (error) {
    console.warn(`[flags] ${key} evaluation failed; treating as off:`, error instanceof Error ? error.message : error)
    return false
  }
}
