import {z} from 'zod'

import type {ReviewAnalysis} from '../ai/review.ts'
import {CRITERION_STATUSES, REVIEW_OUTCOMES} from './contracts.ts'

/**
 * Structural expectations for the live submission-review evaluation
 * (`npm run eval:review`, development plan §5 PR-12 acceptance). A pass
 * means the review has the expected shape (outcome, where problems are, what
 * is not flagged), not that its wording is right. Semantic quality needs a
 * person's reading of each case; a case counts as reviewed only once someone
 * has done so. Every submission in `scripts/review-eval-cases.json` is
 * synthetic.
 */

const expectationSchema = z.strictObject({
  outcomeIn: z.array(z.enum(REVIEW_OUTCOMES)).min(1).optional(),
  outcomeNot: z.array(z.enum(REVIEW_OUTCOMES)).min(1).optional(),
  /** A defect or requirement mismatch covers each of these lines. */
  problemOnLines: z.array(z.number().int().min(1)).optional(),
  /** No defect or requirement mismatch anywhere (uncertain notes are allowed). */
  noProblems: z.boolean().optional(),
  /** Allowed statuses per criterion; `missing` when the review has none (cannot judge). */
  criteria: z.record(z.string(), z.array(z.enum([...CRITERION_STATUSES, 'missing'])).min(1)).optional(),
  /**
   * Driver regressions, checked as plain text on the delivered corrections,
   * independently of the server's own gate: no correction may contain a
   * `forbid` string, and at least one must contain each `require` string, so
   * the step still offers a same-driver fix.
   */
  correction: z.strictObject({forbid: z.array(z.string().min(1)).default([]), require: z.array(z.string().min(1)).default([])}).optional(),
})

const stepSchema = z.strictObject({code: z.string().min(1), expect: expectationSchema})

export const reviewEvalCaseSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  kind: z.enum(['known_defect', 'correct', 'different_correct', 'incomplete_context', 'unfamiliar_approach', 'corrected_resubmission', 'prompt_injection', 'requirement_mismatch', 'wrong_language']),
  description: z.string().min(1),
  steps: z.array(stepSchema).min(1).max(2),
  reviewed: z.boolean(),
})

export type ReviewEvalCase = z.infer<typeof reviewEvalCaseSchema>
export type ReviewExpectation = z.infer<typeof expectationSchema>

const isProblem = (category: string) => category === 'defect' || category === 'requirement_mismatch'

/** Failed expectations, as short reasons; empty when the step passes. */
export function checkReviewStep(analysis: ReviewAnalysis, expect: ReviewExpectation): string[] {
  const failures: string[] = []
  if (expect.outcomeIn && !expect.outcomeIn.includes(analysis.outcome)) failures.push(`outcome ${analysis.outcome} not in [${expect.outcomeIn.join(', ')}]`)
  if (expect.outcomeNot?.includes(analysis.outcome)) failures.push(`outcome ${analysis.outcome} must not be one of [${expect.outcomeNot.join(', ')}]`)
  for (const line of expect.problemOnLines ?? []) {
    if (!analysis.findings.some((finding) => isProblem(finding.category) && finding.startLine <= line && line <= finding.endLine)) {
      failures.push(`no problem finding covers line ${line}`)
    }
  }
  if (expect.noProblems) {
    for (const finding of analysis.findings.filter((candidate) => isProblem(candidate.category))) {
      failures.push(`unexpected ${finding.category} on lines ${finding.startLine}–${finding.endLine}`)
    }
  }
  for (const [criterionId, allowed] of Object.entries(expect.criteria ?? {})) {
    const status = analysis.criteria.find((criterion) => criterion.criterionId === criterionId)?.status ?? 'missing'
    if (!(allowed as string[]).includes(status)) failures.push(`criterion ${criterionId} is ${status}, expected [${allowed.join(', ')}]`)
  }
  if (expect.correction) {
    const corrections = analysis.findings.flatMap((finding) => (finding.correction ? [finding.correction] : []))
    for (const text of expect.correction.forbid) {
      if (corrections.some((correction) => correction.includes(text))) failures.push(`a correction contains ${JSON.stringify(text)}`)
    }
    for (const text of expect.correction.require) {
      if (!corrections.some((correction) => correction.includes(text))) failures.push(`no correction contains ${JSON.stringify(text)}`)
    }
  }
  return failures
}
