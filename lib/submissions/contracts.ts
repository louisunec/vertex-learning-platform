import {z} from 'zod'

import {resolvedCitationSchema} from '../ai/contracts.ts'
import {HELP_POLICY_VERSION, HELP_REASON_CODES} from '../ai/help-policy.ts'
import {EVIDENCE_KINDS} from '../learner/evidence.ts'

/**
 * Public contract of `POST /api/review` (development plan §5 PR-12). Client
 * safe: schemas and constants only. Requests are strict, so a body claiming
 * a learner id, a help level, a verdict, or a score is rejected. Responses
 * carry only what the decided help level allows (`presentAnalysis`).
 */

/** Room for `MAX_SUBMISSION_CHARS` of multi-byte text after JSON escaping. */
export const REVIEW_MAX_BODY_BYTES = 48 * 1024

export const SUBMISSION_LANGUAGES = ['javascript', 'typescript', 'python', 'sql'] as const
export type SubmissionLanguage = (typeof SUBMISSION_LANGUAGES)[number]

export const LANGUAGE_LABELS: Record<SubmissionLanguage, string> = {
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  python: 'Python',
  sql: 'SQL',
}

/**
 * - `defect`: the code on these lines is wrong (a supported problem, criterion optional);
 * - `requirement_mismatch`: a named criterion is not met;
 * - `alternative_valid`: a different but valid way to meet the task, noted, not a problem;
 * - `uncertain`: the reviewer cannot tell from the code, the task, and the sources.
 */
export const FINDING_CATEGORIES = ['defect', 'requirement_mismatch', 'alternative_valid', 'uncertain'] as const
export type FindingCategory = (typeof FINDING_CATEGORIES)[number]

/** Categories a learner may want help with; `alternative_valid` is never a problem. */
export const HELP_WORTHY_CATEGORIES: ReadonlySet<FindingCategory> = new Set(['defect', 'requirement_mismatch', 'uncertain'])

export const CRITERION_STATUSES = ['met', 'not_met', 'unclear'] as const
export type CriterionStatus = (typeof CRITERION_STATUSES)[number]

export const CANNOT_JUDGE_REASONS = ['incomplete_submission', 'off_task', 'unsupported_language', 'insufficient_context'] as const
export type CannotJudgeReason = (typeof CANNOT_JUDGE_REASONS)[number]

/**
 * Derived by the server, never taken from the model. `no_issues_found` is a
 * model's provisional reading against the criteria, not verified correctness.
 */
export const REVIEW_OUTCOMES = ['changes_suggested', 'partly_judged', 'no_issues_found', 'cannot_judge'] as const
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number]

/**
 * How a submission counts as evidence. It never updates mastery: a model
 * review is not an independent grade (development plan §5 PR-12).
 */
export const SUBMISSION_EVIDENCE_REASONS = [
  'first_independent_response',
  'hint_used',
  'answer_exposed',
  'repeat_task',
  'repeat_submission',
] as const
export type SubmissionEvidenceReason = (typeof SUBMISSION_EVIDENCE_REASONS)[number]

export const MAX_CRITERIA = 8
export const MAX_FINDINGS = 6
export const MAX_FINDING_CONCEPTS = 3
export const MAX_FINDING_CITATIONS = 6
export const MAX_QUESTION_LENGTH = 300
export const MAX_EXPLANATION_LENGTH = 600
export const MAX_CORRECTION_LENGTH = 900

const TASK_ID = /^[a-z0-9-]{3,64}$/
const CRITERION_ID = /^[A-Za-z0-9_-]{1,64}$/
const SANITY_ID = /^[A-Za-z0-9._-]{1,128}$/
const REQUEST_KEY = /^[A-Za-z0-9_-]{16,64}$/

export const taskIdSchema = z.string().regex(TASK_ID)
export const criterionIdSchema = z.string().regex(CRITERION_ID)

/** What the lesson page shows the learner: the whole task is learner-visible except its source refs. */
export type LearnerTaskView = {
  lessonId: string
  taskId: string
  version: number
  title: string
  instructions: string
  language: SubmissionLanguage
  criteria: Array<{id: string; text: string}>
}

/**
 * Review a snippet, or ask for more help on a stored review. The two are
 * distinct actions: resubmitting unchanged code never escalates help, and
 * asking for help never re-reviews. GitHub input is a documented follow-up;
 * `submission.type` has only `snippet` for now.
 */
export const reviewRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('review'),
    lessonId: z.string().regex(SANITY_ID),
    taskId: taskIdSchema,
    taskVersion: z.number().int().min(1).max(10_000),
    submission: z.strictObject({type: z.literal('snippet'), content: z.string().min(1).max(20_000)}),
    requestKey: z.string().regex(REQUEST_KEY),
  }),
  z.strictObject({
    action: z.literal('help'),
    reviewId: z.uuid(),
    request: z.enum(['escalate', 'solution']),
    requestKey: z.string().regex(REQUEST_KEY),
  }),
])

export type ReviewRequest = z.infer<typeof reviewRequestSchema>
export type ReviewSubmitRequest = Extract<ReviewRequest, {action: 'review'}>
export type ReviewHelpRequest = Extract<ReviewRequest, {action: 'help'}>

const presentedFindingSchema = z.strictObject({
  id: z.string().regex(/^f\d{1,2}$/),
  category: z.enum(FINDING_CATEGORIES),
  criterionId: criterionIdSchema.nullable(),
  lines: z.strictObject({start: z.number().int().min(1), end: z.number().int().min(1)}).refine((lines) => lines.end >= lines.start),
  /** Server-built from stored chunks; keep every `chunkId`. */
  citations: z.array(resolvedCitationSchema).max(MAX_FINDING_CITATIONS),
  concepts: z.array(z.strictObject({conceptId: z.string().min(1).max(128), name: z.string().min(1).max(200)})).max(MAX_FINDING_CONCEPTS),
  question: z.string().min(1).max(MAX_QUESTION_LENGTH).optional(),
  explanation: z.string().min(1).max(MAX_EXPLANATION_LENGTH).optional(),
  correction: z.string().min(1).max(MAX_CORRECTION_LENGTH).optional(),
})

export type PresentedFinding = z.infer<typeof presentedFindingSchema>

export const reviewResponseSchema = z
  .strictObject({
    reviewId: z.uuid(),
    taskId: taskIdSchema,
    taskVersion: z.number().int().min(1),
    outcome: z.enum(REVIEW_OUTCOMES),
    cannotJudgeReason: z.enum(CANNOT_JUDGE_REASONS).nullable(),
    criteria: z.array(z.strictObject({criterionId: criterionIdSchema, status: z.enum(CRITERION_STATUSES)})).max(MAX_CRITERIA),
    findings: z.array(presentedFindingSchema).max(MAX_FINDINGS),
    help: z.strictObject({
      level: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
      /** The decision behind `level`; null when no help was ever given on this task version. */
      reasonCode: z.enum(HELP_REASON_CODES).nullable(),
      helpEventId: z.uuid().nullable(),
      policyVersion: z.literal(HELP_POLICY_VERSION),
    }),
    /** This submission's record; null for a help response. */
    submission: z
      .strictObject({
        submissionId: z.uuid(),
        /** The analysis was reused: this learner reviewed identical code on this task version before. */
        cached: z.boolean(),
        evidence: z.strictObject({kind: z.enum(EVIDENCE_KINDS), reason: z.enum(SUBMISSION_EVIDENCE_REASONS)}),
      })
      .nullable(),
    replayed: z.boolean(),
    /** A model's reading of the code against the criteria; nothing was run. */
    provisional: z.literal(true),
  })
  .refine(
    (body) => (body.outcome === 'cannot_judge') === (body.cannotJudgeReason !== null) && (body.outcome !== 'cannot_judge' || body.findings.length === 0),
    'Only a review that could not judge carries a reason, and it has no findings',
  )
  .refine(
    (body) =>
      body.findings.every((finding) => {
        const level = body.help.level
        const aside = finding.category === 'alternative_valid'
        return (
          (finding.correction === undefined || level === 3) &&
          (finding.explanation === undefined || level >= 2 || aside) &&
          (finding.question === undefined || level >= 1) &&
          (finding.concepts.length === 0 || level >= 2 || aside)
        )
      }),
    'A finding carries only what the decided help level allows',
  )

export type ReviewResponse = z.infer<typeof reviewResponseSchema>
