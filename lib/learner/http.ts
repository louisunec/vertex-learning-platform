import {AiCallError} from '../ai/gateway.ts'
import {isRetryableDatabaseError} from '../db/errors.ts'
import {ContentUnavailableError} from './content-source.ts'
import {MAX_BODY_BYTES, type LearnerErrorCode} from './contracts.ts'

/**
 * Response helpers shared by the learner-evidence and help route handlers. Private
 * learner responses are never cached. Framework-free (plain `Request` and
 * `Response`) so the body bound is testable under `node --test`.
 */

const NO_STORE = {'Cache-Control': 'no-store'}

export function learnerJson(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, {status, headers: {...NO_STORE, ...headers}})
}

const MESSAGES: Record<LearnerErrorCode, string> = {
  invalid_request: 'Invalid request',
  payload_too_large: 'Request body is too large',
  unauthenticated: 'Sign in required',
  not_found: 'Not found',
  expired: 'This task has expired',
  invalid_option: 'That option was not part of this task',
  task_unavailable: 'This task is no longer available',
  already_submitted: 'This task was already answered',
  idempotency_key_reused: 'This idempotency key was used for a different submission',
  hint_unavailable: 'No reviewed help is available for this task',
  already_answered: 'This question was already answered; ask again with a new request key',
  rate_limited: 'Too many tutor questions; try again later',
  review_in_progress: 'This code is already being reviewed; retry shortly',
  unavailable: 'Temporarily unavailable, please retry',
  internal_error: 'Something went wrong',
}

const STATUS: Record<LearnerErrorCode, number> = {
  invalid_request: 400,
  payload_too_large: 413,
  unauthenticated: 401,
  not_found: 404,
  expired: 410,
  invalid_option: 400,
  task_unavailable: 409,
  already_submitted: 409,
  idempotency_key_reused: 409,
  hint_unavailable: 409,
  already_answered: 409,
  rate_limited: 429,
  review_in_progress: 409,
  unavailable: 503,
  internal_error: 500,
}

export function learnerError(code: LearnerErrorCode): Response {
  return learnerJson({error: MESSAGES[code], code, retryable: code === 'unavailable' || code === 'rate_limited' || code === 'review_in_progress'}, STATUS[code])
}

export type BodyResult = {ok: true; value: unknown} | {ok: false; code: 'invalid_request' | 'payload_too_large'}

/** Reads a JSON body of at most `maxBytes`, stopping as soon as the bound is exceeded. */
export async function readBoundedJson(request: Request, maxBytes = MAX_BODY_BYTES): Promise<BodyResult> {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) return {ok: false, code: 'payload_too_large'}
  if (!request.body) return {ok: false, code: 'invalid_request'}

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const {done, value} = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      return {ok: false, code: 'payload_too_large'}
    }
    chunks.push(value)
  }

  try {
    return {ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8'))}
  } catch {
    return {ok: false, code: 'invalid_request'}
  }
}

/**
 * Maps an unexpected failure to a retryable outage or an internal error;
 * never to a grade or to "no evidence". A failed model call is an outage.
 */
export function failureResponse(route: string, error: unknown): Response {
  if (error instanceof ContentUnavailableError || error instanceof AiCallError || isRetryableDatabaseError(error)) {
    console.error(`[${route}] unavailable:`, error instanceof Error ? error.message : error)
    return learnerError('unavailable')
  }
  console.error(`[${route}] failed:`, error)
  return learnerError('internal_error')
}
