import {z} from 'zod'

/**
 * Shared grounded-AI contracts (development plan §3 "Evidence envelope").
 * Schemas only: generation that produces them arrives with its first consumer
 * (PR-6 tutor). Every field and array is bounded.
 *
 * Division of authority: the model may only return `EvidenceRef`s inside
 * `SupportedFeedback`; the server resolves each ref against the authorized
 * retrieval context and builds the `ResolvedCitation` (times, label, href)
 * from stored records — never from model-generated values.
 */

export const MAX_ID_LENGTH = 128
export const MAX_STATEMENTS = 8
export const MAX_STATEMENT_LENGTH = 600
export const MAX_EVIDENCE_PER_STATEMENT = 4
export const MAX_FOLLOW_UP_LENGTH = 300
export const MAX_CITATION_LABEL_LENGTH = 140

const idSchema = z.string().min(1).max(MAX_ID_LENGTH)
const secondsSchema = z.number().int().nonnegative()

/** Internal lesson path (one URL-safe slug segment), optionally at a second — never an external URL. */
const LESSON_HREF = /^\/lessons\/[A-Za-z0-9._~%-]+(\?t=\d+)?$/

/** A model-returned pointer to one retrieved chunk at the revision it saw. */
export const evidenceRefSchema = z.object({
  chunkId: idSchema,
  chunkRevision: idSchema,
})

/** A server-built citation resolved from stored chunk and lesson records. */
export const resolvedCitationSchema = z
  .object({
    chunkId: idSchema,
    lessonId: idSchema,
    sourceRevision: idSchema,
    startSeconds: secondsSchema,
    endSeconds: secondsSchema,
    label: z.string().min(1).max(MAX_CITATION_LABEL_LENGTH),
    href: z.string().max(300).regex(LESSON_HREF),
  })
  .refine((citation) => citation.endSeconds >= citation.startSeconds, {
    message: 'endSeconds must not precede startSeconds',
    path: ['endSeconds'],
  })

/**
 * Bounded explanation text with evidence refs per statement. Statements with
 * no evidence are connective/instructional text; support checking happens
 * server-side against the allowed evidence set.
 */
export const supportedFeedbackSchema = z.object({
  status: z.enum(['supported', 'partial', 'insufficient_evidence']),
  statements: z
    .array(
      z.object({
        text: z.string().min(1).max(MAX_STATEMENT_LENGTH),
        evidence: z.array(evidenceRefSchema).max(MAX_EVIDENCE_PER_STATEMENT),
      }),
    )
    .max(MAX_STATEMENTS),
  followUp: z.string().min(1).max(MAX_FOLLOW_UP_LENGTH).optional(),
})

export type EvidenceRef = z.infer<typeof evidenceRefSchema>
export type ResolvedCitation = z.infer<typeof resolvedCitationSchema>
export type SupportedFeedback = z.infer<typeof supportedFeedbackSchema>
