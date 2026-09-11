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
