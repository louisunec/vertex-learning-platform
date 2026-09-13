/**
 * Browser calls to the learner routes (PR-4 to PR-7). The server parses every
 * response with its strict schema before sending it, so the client only
 * distinguishes success from the route's `{code, retryable}` error body. A
 * network failure is retryable: resend with the same key, and the route
 * returns the stored result instead of recording twice.
 */

export type ApiResult<T> =
  | {ok: true; status: number; data: T}
  | {ok: false; status: number; code: string; retryable: boolean}

export async function postLearnerJson<T>(url: string, body: unknown): Promise<ApiResult<T>> {
  let response: Response
  try {
    response = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)})
  } catch {
    return {ok: false, status: 0, code: 'network', retryable: true}
  }
  const json: unknown = await response.json().catch(() => null)
  if (response.ok && json && typeof json === 'object') return {ok: true, status: response.status, data: json as T}
  const error = (json && typeof json === 'object' ? json : {}) as {code?: unknown; retryable?: unknown}
  return {
    ok: false,
    status: response.status,
    code: typeof error.code === 'string' ? error.code : 'internal_error',
    retryable: error.retryable === true || response.status >= 502,
  }
}

/** A fresh idempotency/request key; a UUID fits the routes' `[A-Za-z0-9_-]{16,64}`. */
export function newRequestKey(): string {
  return crypto.randomUUID()
}
