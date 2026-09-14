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
   * PR-8: explain-back feedback (`/api/explain` and the lesson-page step). Requires
   * `learner-evidence` too; not `lesson-integration`, `help-policy`, `tutor`, or `submission-review`.
   */
  explainBack: 'explain-back',
} as const

export type FlagKey = (typeof FLAGS)[keyof typeof FLAGS]

/** Whether `key` is on for `distinctId` (Clerk user id or `"anonymous"`). */
export async function isFlagEnabled(key: FlagKey, distinctId: string): Promise<boolean> {
  if (!process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN) return false
  try {
    const flags = await getPostHogClient().evaluateFlags(distinctId, {flagKeys: [key]})
    return flags.isEnabled(key)
  } catch (error) {
    console.warn(`[flags] ${key} evaluation failed; treating as off:`, error instanceof Error ? error.message : error)
    return false
  }
}
