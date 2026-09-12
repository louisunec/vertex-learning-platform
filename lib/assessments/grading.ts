import {z} from 'zod'

import type {ConceptNode} from '../concepts/resolve.ts'

/**
 * Server-only grading projection (development plan §5 PR-4). Unlike the
 * learner projection (`learner.ts`), it carries the answer key, so it is
 * never part of a response type: the attempt service reads it to grade and
 * returns only the grade. Strict, like the learner schema, so a query that
 * starts selecting more fails closed instead of passing extra data along.
 */

export const gradingItemSchema = z
  .strictObject({
    _id: z.string().min(1),
    familyId: z.string().min(1),
    version: z.number().int().min(1),
    lessonId: z.string().min(1),
    optionIds: z.array(z.string().min(1)).min(3).max(4),
    correctOptionId: z.string().min(1),
    primaryConceptRef: z.string().min(1).nullable(),
  })
  .refine((item) => new Set(item.optionIds).size === item.optionIds.length, 'Option ids must be unique')
  .refine((item) => item.optionIds.includes(item.correctOptionId), 'The answer key must name an option')

export type GradingItem = z.infer<typeof gradingItemSchema>

/** Parses one grading row; drafts, release versions, and malformed rows are ungradable (null). */
export function toGradingItem(row: unknown): GradingItem | null {
  const parsed = gradingItemSchema.safeParse(row)
  if (!parsed.success) return null
  const id = parsed.data._id
  return id.startsWith('drafts.') || id.startsWith('versions.') ? null : parsed.data
}

const conceptNodeRowSchema = z.object({
  id: z.string().min(1),
  conceptId: z.string().min(1),
  reviewStatus: z.string().min(1),
  mergedInto: z.string().min(1).nullable().optional(),
  splitInto: z.array(z.string().min(1)).nullable().optional(),
})

/** Indexes published concept rows by document id for `resolveConcept`; invalid rows are dropped. */
export function toConceptIndex(rows: unknown): Map<string, ConceptNode> {
  const index = new Map<string, ConceptNode>()
  if (!Array.isArray(rows)) return index
  for (const row of rows) {
    const parsed = conceptNodeRowSchema.safeParse(row)
    if (!parsed.success) continue
    if (parsed.data.id.startsWith('drafts.') || parsed.data.id.startsWith('versions.')) continue
    index.set(parsed.data.id, parsed.data)
  }
  return index
}
