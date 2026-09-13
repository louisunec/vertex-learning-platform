import {z} from 'zod'

import {MAX_EVIDENCE_PER_STATEMENT, MAX_FOLLOW_UP_LENGTH, MAX_STATEMENT_LENGTH, MAX_STATEMENTS, resolvedCitationSchema} from '../ai/contracts.ts'
import {HELP_MODES, HELP_REASON_CODES, HELP_REQUESTS} from '../ai/help-policy.ts'
import {RETRIEVAL_SCOPES, TUTOR_STATEMENT_KINDS, TUTOR_STATUSES} from '../ai/tutor.ts'
import {MAX_HINT_LENGTH} from '../assessments/hints.ts'
import {learnerAssessmentSchema} from '../assessments/learner.ts'
import {EVIDENCE_KINDS, EVIDENCE_REASONS} from './evidence.ts'

/**
 * Public contracts of the learner-evidence routes (development plan §5 PR-4).
 * Requests are strict: a body carrying anything beyond the listed keys — a
 * user id, a score, a correctness flag, a help level — is rejected, so the
 * client can never assert what only the server knows. Responses are strict
 * too: none has a field for an answer key or reasons, and only the help
 * response (PR-5) carries a hint — exactly one, the decided level's.
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

/**
 * One help request (development plan §5 PR-5). `mode` and `request` are the
 * learner's own choice of how much help they want and can only raise the
 * recorded assistance; the level itself is decided and stored by the server,
 * so a body claiming a level or help history is rejected.
 */
export const helpRequestSchema = z.strictObject({
  taskInstanceId: z.uuid(),
  mode: z.enum(HELP_MODES),
  request: z.enum(HELP_REQUESTS),
  requestKey: z.string().regex(IDEMPOTENCY_KEY),
})

export type HelpRequest = z.infer<typeof helpRequestSchema>

const hintTextSchema = z.string().min(1).max(MAX_HINT_LENGTH)

/** The decided rung only; the correct option id appears with the solution (level 3) and nowhere else. */
const deliveredHintSchema = z.discriminatedUnion('level', [
  z.strictObject({level: z.literal(1), text: hintTextSchema}),
  z.strictObject({level: z.literal(2), text: hintTextSchema}),
  z.strictObject({level: z.literal(3), text: hintTextSchema, correctOptionId: z.string().min(1).max(128)}),
])

export const helpResponseSchema = z
  .strictObject({
    helpEventId: z.uuid(),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    reasonCode: z.enum(HELP_REASON_CODES),
    policyVersion: z.string().min(1).max(64),
    hint: deliveredHintSchema,
    replayed: z.boolean(),
  })
  .refine((body) => body.hint.level === body.level, 'The hint must be the decided level')

export type HelpResponse = z.infer<typeof helpResponseSchema>

export const MAX_TUTOR_QUESTION_LENGTH = 500
/** A day: longer than any lesson video, so the stored duration is the real bound. */
export const MAX_PLAYHEAD_SECONDS = 86_400
const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/

/**
 * One tutor question (development plan §5 PR-6). As with help, `mode` and
 * `helpRequest` only ask for more help; the level is decided and stored by
 * the server. `requestKey` makes a retry unable to escalate or double-record.
 */
export const tutorRequestSchema = z.strictObject({
  lessonId: z.string().regex(SANITY_ID),
  currentSeconds: z.number().int().min(0).max(MAX_PLAYHEAD_SECONDS),
  question: z.string().trim().min(3).max(MAX_TUTOR_QUESTION_LENGTH),
  mode: z.enum(HELP_MODES),
  helpRequest: z.enum(HELP_REQUESTS).optional(),
  sessionId: z.string().regex(SESSION_ID).optional(),
  taskInstanceId: z.uuid().optional(),
  requestKey: z.string().regex(IDEMPOTENCY_KEY),
})

export type TutorRequest = z.infer<typeof tutorRequestSchema>

const tutorStatementSchema = z.strictObject({
  kind: z.enum(TUTOR_STATEMENT_KINDS),
  text: z.string().min(1).max(MAX_STATEMENT_LENGTH),
  citations: z.array(resolvedCitationSchema).max(MAX_EVIDENCE_PER_STATEMENT),
})

/**
 * A tutor answer: server-validated statements whose citations were built
 * from stored records. No hint, answer-key, or raw source field exists.
 * `help` is null exactly when no help was delivered (insufficient evidence).
 */
export const tutorResponseSchema = z
  .strictObject({
    tutorRequestId: z.uuid(),
    status: z.enum(TUTOR_STATUSES),
    scope: z.enum(RETRIEVAL_SCOPES),
    statements: z.array(tutorStatementSchema).max(MAX_STATEMENTS),
    followUp: z.string().min(1).max(MAX_FOLLOW_UP_LENGTH).optional(),
    message: z.string().min(1).max(200).optional(),
    help: z
      .strictObject({
        helpEventId: z.uuid(),
        level: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
        reasonCode: z.enum(HELP_REASON_CODES),
        policyVersion: z.string().min(1).max(64),
      })
      .nullable(),
  })
  .refine(
    (body) =>
      body.status === 'insufficient_evidence'
        ? body.help === null && body.statements.length === 0 && body.message !== undefined
        : body.help !== null && body.message === undefined,
    'Insufficient evidence delivers no help and only the fixed message',
  )
  .refine(
    (body) => (body.status === 'clarification_needed') === (body.help?.level === 0) && (body.status !== 'clarification_needed' || body.statements.length === 0),
    'A clarifying question is level 0 and makes no statements',
  )
  .refine(
    (body) => body.statements.every((statement) => (statement.kind === 'claim') === statement.citations.length > 0),
    'Only claims carry citations, and every claim has one',
  )

export type TutorResponse = z.infer<typeof tutorResponseSchema>

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
  'hint_unavailable',
  'already_answered',
  'rate_limited',
  'unavailable',
  'internal_error',
] as const

export type LearnerErrorCode = (typeof LEARNER_ERROR_CODES)[number]
