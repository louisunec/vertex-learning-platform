import {z} from 'zod'

/**
 * Learner-safe assessment projection (development plan §3 "Request
 * authorization", §5 PR-1). The Sanity read token can see every field, so
 * this schema is the barrier: it is strict, so a row carrying anything beyond
 * the allowed keys — an answer key, hints, source text, generation metadata —
 * is dropped rather than passed on. Consumers arrive with PR-4/PR-7.
 */

export const learnerOptionSchema = z.strictObject({
  id: z.string().min(1),
  text: z.string().min(1),
})

export const learnerAssessmentSchema = z.strictObject({
  _id: z.string().min(1),
  _rev: z.string().min(1),
  familyId: z.string().min(1),
  version: z.number().int().min(1),
  lessonId: z.string().min(1),
  type: z.enum(['recall', 'apply', 'transfer']),
  responseFormat: z.literal('single_choice'),
  question: z.string().min(1),
  options: z.array(learnerOptionSchema).min(3).max(4),
})

export type LearnerAssessment = z.infer<typeof learnerAssessmentSchema>

/**
 * Parses projected rows, drops invalid, over-exposed, draft, and release rows,
 * and keeps only the highest version per family.
 */
export function toLearnerAssessments(rows: unknown): LearnerAssessment[] {
  if (!Array.isArray(rows)) return []
  const latest = new Map<string, LearnerAssessment>()
  for (const row of rows) {
    const parsed = learnerAssessmentSchema.safeParse(row)
    if (!parsed.success) continue
    const item = parsed.data
    if (item._id.startsWith('drafts.') || item._id.startsWith('versions.')) continue
    const current = latest.get(item.familyId)
    if (!current || item.version > current.version) latest.set(item.familyId, item)
  }
  return [...latest.values()].toSorted((a, b) => a.familyId.localeCompare(b.familyId))
}

/**
 * One item a lesson's understanding check may issue (PR-7). `primaryConceptRef`
 * and `firstSeconds` are server-side selection inputs only; nothing but
 * `item` (learner-safe) ever reaches a response.
 */
export type CheckCandidate = {
  item: LearnerAssessment
  primaryConceptRef: string | null
  /** Earliest cited source second, or null when the item cites none. */
  firstSeconds: number | null
}

const checkCandidateRowSchema = z.object({
  item: z.looseObject({_id: z.string()}),
  primaryConceptRef: z.string().min(1).nullish(),
  firstSeconds: z.number().nonnegative().nullish(),
})

/**
 * Parses `LESSON_CHECK_CANDIDATES_QUERY` rows. Items go through
 * `toLearnerAssessments`, so a candidate is always an item that can be issued
 * exactly as projected: invalid, draft, and superseded rows are dropped.
 */
export function toCheckCandidates(rows: unknown): CheckCandidate[] {
  if (!Array.isArray(rows)) return []
  const parsed = rows.flatMap((row) => {
    const result = checkCandidateRowSchema.safeParse(row)
    return result.success ? [result.data] : []
  })
  return toLearnerAssessments(parsed.map((row) => row.item)).map((item) => {
    const row = parsed.find((candidate) => candidate.item._id === item._id)
    return {item, primaryConceptRef: row?.primaryConceptRef ?? null, firstSeconds: row?.firstSeconds ?? null}
  })
}
