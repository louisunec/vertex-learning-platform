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
  /** The My Learning knowledge map (`/my-learning/knowledge-map`). Requires `learner-evidence` too. */
  knowledgeMap: 'knowledge-map',
  /**
   * PR-7: the lesson-page tutor panel and understanding check (`/api/lesson-check`). The check
   * requires `learner-evidence`, its hints `help-policy`, and the panel all three flags above.
   */
  lessonIntegration: 'lesson-integration',
  /** My Learning focused review (`/my-learning/reviews`, `/api/review-session`). Requires `learner-evidence` too. */
  review: 'review-session',
  /**
   * PR-11: the learning goal and next actions (`/api/goal`, `/api/next`, `/learn`, and the My
   * Learning goal and recommendation cards). Requires `learner-evidence` too. Practice items
   * also need `review-session`, and check items `lesson-integration`.
   */
  nextAction: 'next-action',
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

/** The knowledge map reads learner evidence, so it needs `learner-evidence` as well as its own flag. */
export async function isKnowledgeMapEnabled(distinctId: string): Promise<boolean> {
  const [map, evidence] = await Promise.all([
    isFlagEnabled(FLAGS.knowledgeMap, distinctId),
    isFlagEnabled(FLAGS.learnerEvidence, distinctId),
  ])
  return map && evidence
}

/** The focused review issues and grades tasks, so it needs `learner-evidence` as well as its own flag. */
export async function isReviewEnabled(distinctId: string): Promise<boolean> {
  const [review, evidence] = await Promise.all([
    isFlagEnabled(FLAGS.review, distinctId),
    isFlagEnabled(FLAGS.learnerEvidence, distinctId),
  ])
  return review && evidence
}

/** Next actions read the goal and evidence from the learner database, so they need `learner-evidence` too. */
export async function isNextActionEnabled(distinctId: string): Promise<boolean> {
  const [next, evidence] = await Promise.all([
    isFlagEnabled(FLAGS.nextAction, distinctId),
    isFlagEnabled(FLAGS.learnerEvidence, distinctId),
  ])
  return next && evidence
}

/**
 * The routes a next action may send an enabled learner to, beyond lesson
 * pages: focused review, and the lesson check (whose own gate is
 * `lesson-integration` + `learner-evidence`; call only once next actions are
 * enabled, which already requires `learner-evidence`).
 */
export async function nextActionCapabilities(distinctId: string): Promise<{practice: boolean; checks: boolean}> {
  const [practice, checks] = await Promise.all([isReviewEnabled(distinctId), isFlagEnabled(FLAGS.lessonIntegration, distinctId)])
  return {practice, checks}
}
