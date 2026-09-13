import {z} from 'zod'

import {MAX_FOLLOW_UP_LENGTH, MAX_STATEMENT_LENGTH, MAX_STATEMENTS, resolvedCitationSchema} from '../ai/contracts.ts'
import {HELP_MODES, HELP_REASON_CODES, HELP_REQUESTS} from '../ai/help-policy.ts'
import {CITED_STATEMENT_KINDS, MAX_TUTOR_CITATIONS, RETRIEVAL_SCOPES, TUTOR_STATEMENT_KINDS, TUTOR_STATUSES} from '../ai/tutor.ts'
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

export const LESSON_CHECK_KINDS = ['check', 'follow_up'] as const
export type LessonCheckKind = (typeof LESSON_CHECK_KINDS)[number]

/** Why no question was issued; none of these is evidence about the learner. */
export const LESSON_CHECK_NONE_REASONS = ['no_items', 'all_checked', 'no_variant'] as const

/**
 * The next question of a lesson's understanding check (development plan §5
 * PR-7). The server chooses the item: `check` asks for the next idea the
 * learner has not answered; `follow_up` asks for an unseen reviewed variant
 * of an answered task's concept. The body names no assessment.
 */
export const lessonCheckRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({lessonId: z.string().regex(SANITY_ID), kind: z.literal('check')}),
  z.strictObject({lessonId: z.string().regex(SANITY_ID), kind: z.literal('follow_up'), afterTaskInstanceId: z.uuid()}),
])

export type LessonCheckRequest = z.infer<typeof lessonCheckRequestSchema>

const CHECK_COUNT = z.number().int().min(0).max(50)

export const lessonCheckResponseSchema = z.discriminatedUnion('status', [
  z
    .strictObject({
      status: z.literal('issued'),
      kind: z.enum(LESSON_CHECK_KINDS),
      task: issueTaskResponseSchema,
      /** An unexpired, unanswered instance of the same item was handed back instead of a new one. */
      resumed: z.boolean(),
      /** `check` only: ideas in the lesson, and those not yet answered including this one. */
      progress: z.strictObject({remaining: CHECK_COUNT.min(1), total: CHECK_COUNT.min(1)}).nullable(),
    })
    .refine((body) => (body.kind === 'check') === (body.progress !== null), 'Only a check question carries progress'),
  z.strictObject({status: z.literal('none'), kind: z.enum(LESSON_CHECK_KINDS), reason: z.enum(LESSON_CHECK_NONE_REASONS)}),
])

export type LessonCheckResponse = z.infer<typeof lessonCheckResponseSchema>

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

/**
 * One tutor statement. A claim cites up to two passages of up to three
 * time-adjacent chunks, and each chunk is its own citation, so a statement
 * carries 1–`MAX_TUTOR_CITATIONS` (6) citations; a level-1 pointer carries
 * one. (Before follow-up 3 the cap was 4; the shared evidence-envelope cap
 * `MAX_EVIDENCE_PER_STATEMENT`, 4, is unchanged and does not apply here.)
 *
 * For clients (PR-7 `TutorPanel` citation buttons, PR-10 feedback): keep
 * every citation's `chunkId` and `sourceRevision`, in order. Citations of
 * one statement that share a `lessonId` and are contiguous (each starts at
 * or before the previous one's `endSeconds`, the rule `assemblePassages`
 * uses) may be shown as one time range that seeks to the first
 * `startSeconds`; the ids stay separate.
 */
const tutorStatementSchema = z.strictObject({
  kind: z.enum(TUTOR_STATEMENT_KINDS),
  text: z.string().min(1).max(MAX_STATEMENT_LENGTH),
  citations: z.array(resolvedCitationSchema).max(MAX_TUTOR_CITATIONS),
})

/**
 * A tutor answer: server-validated statements whose citations were built
 * from stored records and whose support was model-checked (not proven).
 * No hint, answer-key, or raw source field exists.
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
    (body) => body.statements.every((statement) => CITED_STATEMENT_KINDS.has(statement.kind) === statement.citations.length > 0),
    'Only claims and pointers carry citations, and each has one',
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

/* ---------- Focused review (prompts/focused-review.md) ---------- */

/**
 * Why a concept is in a review: its latest counted answer in the window was
 * not an independent correct one. In order of urgency.
 */
export const REVIEW_REASONS = ['independent_incorrect', 'assisted_incorrect', 'assisted_correct'] as const
export type ReviewReason = (typeof REVIEW_REASONS)[number]

/** Why no review was started; neither is evidence about the learner. */
export const REVIEW_NONE_REASONS = ['no_recent_mistakes', 'no_unseen_questions'] as const

export const MAX_REVIEW_CONCEPTS = 3
export const MAX_REVIEW_ITEMS = 5

/** Starting or resuming a review names nothing: the server chooses every item. */
export const reviewSessionRequestSchema = z.strictObject({})

const REVIEW_POSITION = z.number().int().min(1).max(MAX_REVIEW_ITEMS)
const REVIEW_CONCEPT_ID = z.string().min(1).max(128)

/**
 * One question of a review. Only an open item carries its learner-safe task;
 * `refresher` names the cited lesson moment, whose link is issued only by
 * `POST /api/review-session/refresher`, which records it as help.
 */
const reviewItemSchema = z.discriminatedUnion('state', [
  z.strictObject({
    position: REVIEW_POSITION,
    conceptId: REVIEW_CONCEPT_ID,
    state: z.literal('open'),
    task: issueTaskResponseSchema,
    refresher: z
      .strictObject({
        lessonTitle: z.string().min(1).max(200),
        startSeconds: z.number().int().min(0).max(MAX_PLAYHEAD_SECONDS),
      })
      .nullable(),
  }),
  z.strictObject({
    position: REVIEW_POSITION,
    conceptId: REVIEW_CONCEPT_ID,
    /** `unavailable`: withdrawn or changed since it was issued, so it can't be answered. */
    state: z.enum(['answered', 'unavailable']),
  }),
])

export type ReviewItem = z.infer<typeof reviewItemSchema>

export const reviewSessionResponseSchema = z.discriminatedUnion('status', [
  z
    .strictObject({
      status: z.literal('active'),
      sessionId: z.uuid(),
      expiresAt: z.iso.datetime(),
      /** An unfinished session was handed back instead of a new one. */
      resumed: z.boolean(),
      concepts: z
        .array(
          z.strictObject({
            conceptId: REVIEW_CONCEPT_ID,
            /** Null when the concept is no longer servable under that id. */
            name: z.string().min(1).max(200).nullable(),
            reason: z.enum(REVIEW_REASONS),
          }),
        )
        .min(1)
        .max(MAX_REVIEW_CONCEPTS),
      items: z.array(reviewItemSchema).min(1).max(MAX_REVIEW_ITEMS),
    })
    .refine(
      (body) =>
        body.items.every((item, i) => item.position === i + 1) &&
        body.items.every((item) => body.concepts.some((concept) => concept.conceptId === item.conceptId)),
      'Items are numbered from 1 and belong to a listed concept',
    ),
  z.strictObject({status: z.literal('none'), reason: z.enum(REVIEW_NONE_REASONS)}),
])

export type ReviewSessionResponse = z.infer<typeof reviewSessionResponseSchema>

export const reviewRefresherRequestSchema = z.strictObject({
  taskInstanceId: z.uuid(),
  requestKey: z.string().regex(IDEMPOTENCY_KEY),
})

export type ReviewRefresherRequest = z.infer<typeof reviewRefresherRequestSchema>

/** The lesson moment the item cites, as a lesson-page deep link (`?t=` seconds). */
export const reviewRefresherResponseSchema = z.strictObject({
  helpEventId: z.uuid(),
  href: z.string().regex(/^\/lessons\/[^/?#\s]+\?t=\d{1,5}$/),
  replayed: z.boolean(),
})

export type ReviewRefresherResponse = z.infer<typeof reviewRefresherResponseSchema>
