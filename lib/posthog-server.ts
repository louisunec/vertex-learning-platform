import { PostHog } from "posthog-node";

let posthogClient: PostHog | null = null;

export function getPostHogClient(): PostHog {
  const token = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST;

  if (!token) {
    if (process.env.NODE_ENV !== "production") {
      console.error(
        "NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN variable required by PostHog is missing or un-configured, " +
          "this causes events to be silently missed. This error stops appearing once NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN is configured"
      );
    }
  }

  if (!posthogClient) {
    posthogClient = new PostHog(token ?? "", {
      host,
      flushAt: 1,
      flushInterval: 0,
      // Server-only; enables local feature-flag evaluation (lib/flags.ts).
      // Without it, each evaluation is a remote /flags request.
      secretKey: process.env.POSTHOG_SECRET_KEY || undefined,
      // Bound remote flag evaluation so a slow PostHog never stalls a request.
      featureFlagsRequestTimeoutMs: 1500,
    });
  }

  return posthogClient;
}
