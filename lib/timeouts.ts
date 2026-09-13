/**
 * Request-path timeouts, defined in one place (development plan §3). Each can
 * be overridden with a server env var; a missing, non-integer, or out-of-range
 * value falls back to the default, so a typo never removes the bound.
 *
 * Framework-free (no `server-only`) so the gateway stays loadable under
 * `node --test`; these are non-secret, non-`NEXT_PUBLIC_` values.
 */

export const MIN_TIMEOUT_MS = 1_000
export const MAX_TIMEOUT_MS = 60_000

/** Parses a timeout override in milliseconds, falling back to `fallback`. */
export function readTimeoutMs(
  name: string,
  fallback: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  return Number.isInteger(value) && value >= MIN_TIMEOUT_MS && value <= MAX_TIMEOUT_MS ? value : fallback
}

/** Structured model calls through `lib/ai/gateway`. */
export const AI_GATEWAY_TIMEOUT_MS = readTimeoutMs('AI_GATEWAY_TIMEOUT_MS', 10_000)

/** The tutor's explanation call (`lib/ai/tutor.ts`), which needs longer than keyword extraction. */
export const TUTOR_TIMEOUT_MS = readTimeoutMs('TUTOR_TIMEOUT_MS', 20_000)

/** Sanity Context MCP connection and each `groq_query` call. */
export const MCP_TIMEOUT_MS = readTimeoutMs('MCP_TIMEOUT_MS', 8_000)
