import {z} from 'zod'

import {resolvedCitationSchema} from '../ai/contracts.ts'
import {EVIDENCE_KINDS} from '../learner/evidence.ts'
import {MAX_EXPLANATION_CHARS} from './text.ts'

/**
 * Public contract of `POST /api/explain` (development plan §5 PR-8). Client
 * safe: schemas and constants only. The request is strict, so a body
 * claiming a learner id, a status, a score, or a source is rejected. The
 * response carries criterion-level feedback only: no coverage score or
 * mastery field exists, and a criterion's private rubric text never appears.
 */

/** Room for `MAX_EXPLANATION_CHARS` of multi-byte text after JSON escaping. */
export const EXPLAIN_MAX_BODY_BYTES = 16 * 1024

/**
 * The statuses the model may assign:
 * - `demonstrated`: the explanation conveys this point (any accurate wording);
 * - `missing`: it does not mention this point, which is not the same as wrong;
 * - `unclear`: it touches the point, but the wording can be read more than one way;
 * - `contradicted`: it says the opposite of what a cited course passage states;
 * - `insufficient_evidence`: the course passages cannot settle what it says, so it is not judged.
 */
export const MODEL_CRITERION_STATUSES = ['demonstrated', 'missing', 'unclear', 'contradicted', 'insufficient_evidence'] as const

/**
 * Plus the server's own status, `not_validated`: the model's judgment of the
 * point failed a server check (it left the point out, quoted words the text
 * does not contain, or claimed a contradiction without a course passage for
 * that point), so the point is not judged. It says nothing about the
 * learner's wording or about what the course covers.
 */
export const CRITERION_STATUSES = [...MODEL_CRITERION_STATUSES, 'not_validated'] as const
export type CriterionStatus = (typeof CRITERION_STATUSES)[number]

/** `off_topic`: the text does not attempt the prompt (irrelevant, or only instructions), so no criterion is judged. */
export const EXPLANATION_OUTCOMES = ['assessed', 'off_topic'] as const
export type ExplanationOutcome = (typeof EXPLANATION_OUTCOMES)[number]

/**
 * How one explanation counts as evidence. It is its own evidence type and
 * never updates mastery: an unassisted explanation (`independent`) is not
 * independent application of the skill (development plan §5 PR-4, PR-8).
 */
export const EXPLANATION_EVIDENCE_REASONS = [
  'first_independent_response',
  'hint_used',
  'answer_exposed',
  'revision_after_feedback',
  'repeat_submission',
  'not_assessable',
] as const
export type ExplanationEvidenceReason = (typeof EXPLANATION_EVIDENCE_REASONS)[number]

export const MAX_CRITERIA = 5
export const MAX_LABEL_LENGTH = 120
export const MAX_FEEDBACK_LENGTH = 400
export const MAX_FOLLOW_UP_LENGTH = 250
export const MAX_CRITERION_CITATIONS = 6

const TASK_ID = /^[a-z0-9-]{3,64}$/
const CRITERION_ID = /^[A-Za-z0-9_-]{1,64}$/
const SANITY_ID = /^[A-Za-z0-9._-]{1,128}$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,64}$/

export const taskIdSchema = z.string().regex(TASK_ID)
export const criterionIdSchema = z.string().regex(CRITERION_ID)

/** What the lesson page shows before any feedback: the prompt, never the rubric. */
export type LearnerExplainTaskView = {
  lessonId: string
  taskId: string
  version: number
  title: string
  prompt: string
}

export const explainRequestSchema = z.strictObject({
  lessonId: z.string().regex(SANITY_ID),
  taskId: taskIdSchema,
  taskVersion: z.number().int().min(1).max(10_000),
  /** Raw text, bounded again after normalization (`normalizeExplanation`). */
  text: z.string().min(1).max(MAX_EXPLANATION_CHARS * 4),
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY),
})

export type ExplainRequest = z.infer<typeof explainRequestSchema>

const spanSchema = z.strictObject({start: z.number().int().min(0), end: z.number().int().min(1)}).refine((span) => span.end > span.start)

const criterionFeedbackSchema = z.strictObject({
  criterionId: criterionIdSchema,
  /** Learner-facing topic of the point, written by an editor. */
  label: z.string().min(1).max(MAX_LABEL_LENGTH),
  required: z.boolean(),
  status: z.enum(CRITERION_STATUSES),
  /** Character offsets into the submitted (normalized) text that the judgment is about. */
  span: spanSchema.nullable(),
  feedback: z.string().min(1).max(MAX_FEEDBACK_LENGTH).nullable(),
  /** Server-built from stored chunks; keep every `chunkId`. */
  citations: z.array(resolvedCitationSchema).max(MAX_CRITERION_CITATIONS),
})

export type CriterionFeedback = z.infer<typeof criterionFeedbackSchema>

export const explainResponseSchema = z
  .strictObject({
    explanationId: z.uuid(),
    taskId: taskIdSchema,
    taskVersion: z.number().int().min(1),
    outcome: z.enum(EXPLANATION_OUTCOMES),
    criteria: z.array(criterionFeedbackSchema).max(MAX_CRITERIA),
    followUpQuestion: z.string().min(1).max(MAX_FOLLOW_UP_LENGTH).nullable(),
    /** Length of the normalized text the spans refer to. */
    charCount: z.number().int().min(1).max(MAX_EXPLANATION_CHARS),
    attempt: z.strictObject({
      /** This learner's evaluated explanations of the task so far, this one included. */
      number: z.number().int().min(1),
      /** The earlier explanation whose feedback this one follows; null for a first explanation. */
      revisionOf: z.uuid().nullable(),
      /** The evaluation was reused: this learner submitted identical text for this task version before. */
      cached: z.boolean(),
      evidence: z.strictObject({kind: z.enum(EVIDENCE_KINDS), reason: z.enum(EXPLANATION_EVIDENCE_REASONS)}),
    }),
    replayed: z.boolean(),
    /** A model's reading against the task's points, not a grade. */
    provisional: z.literal(true),
  })
  .refine((body) => (body.outcome === 'off_topic') === (body.criteria.length === 0), 'Only an off-topic explanation has no criteria')
  .refine((body) => body.criteria.every((criterion) => !criterion.span || criterion.span.end <= body.charCount), 'Spans lie inside the text')
  .refine(
    (body) =>
      body.criteria.every(
        (criterion) =>
          ((criterion.status !== 'missing' && criterion.status !== 'not_validated') || criterion.span === null) &&
          (criterion.status !== 'contradicted' || (criterion.span !== null && criterion.citations.length > 0)) &&
          (criterion.status !== 'demonstrated' || criterion.span !== null),
      ),
    'A missing or unvalidated point quotes nothing; a demonstrated point quotes the text; a contradiction quotes the text and cites the course',
  )

export type ExplainResponse = z.infer<typeof explainResponseSchema>
