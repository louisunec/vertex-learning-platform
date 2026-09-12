import {z} from 'zod'

import {learnerAssessmentSchema} from '../assessments/learner.ts'
import {EVIDENCE_KINDS, EVIDENCE_REASONS} from './evidence.ts'

/**
 * Public contracts of the learner-evidence routes (development plan §5 PR-4).
 * Requests are strict: a body carrying anything beyond the listed keys — a
 * user id, a score, a correctness flag, a help level — is rejected, so the
 * client can never assert what only the server knows. Responses are strict
 * too, and none of them has a field for an answer key, hints, or reasons.
 */

export const MAX_BODY_BYTES = 2048
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,64}$/
const SANITY_ID = /^[A-Za-z0-9._-]{1,128}$/

export const issueTaskRequestSchema = z.strictObject({
  assessmentId: z.string().regex(SANITY_ID),
})

export const issueTaskResponseSchema = z.strictObject({
  taskInstanceId: z.uuid(),
  expiresAt: z.iso.datetime(),
  item: learnerAssessmentSchema,
})

export type IssueTaskResponse = z.infer<typeof issueTaskResponseSchema>

export const submitAttemptRequestSchema = z.strictObject({
  taskInstanceId: z.uuid(),
  optionId: z.string().min(1).max(128),
  selfConfidence: z.number().int().min(1).max(5).optional(),
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY),
})

export type SubmitAttemptRequest = z.infer<typeof submitAttemptRequestSchema>

export const attemptResultSchema = z.strictObject({
  attemptId: z.uuid(),
  taskInstanceId: z.uuid(),
  correct: z.boolean(),
  evidence: z.strictObject({
    kind: z.enum(EVIDENCE_KINDS),
    reasonCode: z.enum(EVIDENCE_REASONS),
  }),
})

export type AttemptResult = z.infer<typeof attemptResultSchema>

/** Error codes a client can act on; `retryable` failures carry no grade. */
export const LEARNER_ERROR_CODES = [
  'invalid_request',
  'payload_too_large',
  'unauthenticated',
  'not_found',
  'expired',
  'invalid_option',
  'task_unavailable',
  'already_submitted',
  'idempotency_key_reused',
  'unavailable',
  'internal_error',
] as const

export type LearnerErrorCode = (typeof LEARNER_ERROR_CODES)[number]
