import {z} from 'zod'

/**
 * Server-only hint ladder projection (development plan §5 PR-5). Like the
 * grading projection (`grading.ts`) it carries private data — every rung and
 * the answer key — so it is never part of a response type: the help service
 * copies out only the rung the policy decided. Strict, so a query that
 * starts selecting more fails closed. A missing or empty rung makes the
 * whole ladder unavailable rather than letting a hint be improvised.
 */

/** Longest rung the generator writes (`FIELD_LIMITS` in `generate.ts`: 500, 500, 800). */
export const MAX_HINT_LENGTH = 800

const rung = z.string().trim().min(1).max(MAX_HINT_LENGTH)

export const hintLadderSchema = z
  .strictObject({
    _id: z.string().min(1),
    familyId: z.string().min(1),
    version: z.number().int().min(1),
    optionIds: z.array(z.string().min(1)).min(3).max(4),
    correctOptionId: z.string().min(1),
    direction: rung,
    keyConcept: rung,
    solution: rung,
  })
  .refine((ladder) => new Set(ladder.optionIds).size === ladder.optionIds.length, 'Option ids must be unique')
  .refine((ladder) => ladder.optionIds.includes(ladder.correctOptionId), 'The answer key must name an option')

export type HintLadder = z.infer<typeof hintLadderSchema>

export type HintRungLevel = 1 | 2 | 3

/** Parses one ladder row; drafts, release versions, and malformed or incomplete rows are unavailable (null). */
export function toHintLadder(row: unknown): HintLadder | null {
  const parsed = hintLadderSchema.safeParse(row)
  if (!parsed.success) return null
  const id = parsed.data._id
  return id.startsWith('drafts.') || id.startsWith('versions.') ? null : parsed.data
}

/** The reviewed text for one level: 1 direction, 2 key concept, 3 solution. */
export function hintText(ladder: HintLadder, level: HintRungLevel): string {
  switch (level) {
    case 1:
      return ladder.direction
    case 2:
      return ladder.keyConcept
    case 3:
      return ladder.solution
  }
}
