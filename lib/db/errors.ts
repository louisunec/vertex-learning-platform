/**
 * Classifies database failures that a client may retry (development plan §3:
 * an outage produces a retryable error, never a grade or an empty result).
 * Framework-free so services and tests can use it.
 */

export class DatabaseUnavailableError extends Error {
  constructor(message: string, options?: {cause?: unknown}) {
    super(message, options)
    this.name = 'DatabaseUnavailableError'
  }
}

/** Node socket errors raised while connecting or mid-query. */
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'])

/** postgres.js client-side connection failures. */
const DRIVER_CODES = new Set(['CONNECT_TIMEOUT', 'CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECTION_DESTROYED'])

/**
 * Postgres SQLSTATEs that mean "try again": connection exceptions (08),
 * serialization failure, deadlock, too many connections, admin shutdown,
 * query canceled (statement timeout), and the server being unavailable.
 */
const RETRYABLE_SQLSTATES = new Set(['40001', '40P01', '53300', '57014', '57P01', '57P02', '57P03'])

export function isRetryableDatabaseError(error: unknown): boolean {
  if (error instanceof DatabaseUnavailableError) return true
  const code = (error as {code?: unknown} | null)?.code
  if (typeof code !== 'string') return false
  return NETWORK_CODES.has(code) || DRIVER_CODES.has(code) || RETRYABLE_SQLSTATES.has(code) || code.startsWith('08')
}
