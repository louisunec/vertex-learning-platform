import {z} from 'zod'

import type {ExplanationAnalysis} from '../ai/explain.ts'
import {CRITERION_STATUSES, EXPLANATION_OUTCOMES} from './contracts.ts'
import type {ExplainTask} from './task.ts'
import {copiesPoint, LEAK_WORDS} from './text.ts'

/**
 * Checks for the offline explain-back evaluation (`npm run eval:explain`).
 * Two separate verdicts per step, so a well-formed answer is never mistaken
 * for a correct one:
 *
 * - structural: what the contract and the gates promise (a status for every
 *   point, spans inside the text, citations only from that point's reviewed
 *   sources, no internal ids or copied rubric text, one follow-up question);
 * - semantic: the acceptable statuses written for each case before any
 *   model run (`scripts/explain-eval-cases.json`).
 *
 * Neither is a person's reading of the feedback text; the review packet
 * keeps that separate.
 */

const expectSchema = z.strictObject({
  /** Acceptable outcomes. */
  outcome: z.array(z.enum(EXPLANATION_OUTCOMES)).min(1).default(['assessed']),
  /** Acceptable statuses per criterion id; a criterion not listed may have any status. */
  criteria: z.record(z.string(), z.array(z.enum(CRITERION_STATUSES)).min(1)).default({}),
  /** Statuses no criterion may have (for example, nothing demonstrated for irrelevant text). */
  forbidStatuses: z.array(z.enum(CRITERION_STATUSES)).default([]),
  /** `required`: a follow-up question must be offered. */
  followUp: z.enum(['required', 'any']).default('any'),
})

export const explainEvalCaseSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{3,48}$/),
  description: z.string().min(1).max(300),
  /** An eval-only task variant: one criterion's sources replaced, to test missing or unrelated source evidence. */
  variant: z
    .strictObject({
      criterionId: z.string().min(1),
      sourceChunkRefs: z
        .array(z.strictObject({chunkId: z.string().min(3), chunkRevision: z.string().min(1), startSeconds: z.number().int().min(0), endSeconds: z.number().int().min(0)}))
        .min(1)
        .max(4),
    })
    .optional(),
  /** Steps run in order; a later step is the learner's revision after reading the earlier feedback. */
  steps: z
    .array(z.strictObject({text: z.string().min(10).max(1500), expect: expectSchema}))
    .min(1)
    .max(3),
})

export type ExplainEvalCase = z.infer<typeof explainEvalCaseSchema>
export type ExplainExpectation = z.infer<typeof expectSchema>

/** Words that expose the pipeline rather than help the learner (as in the gate, plus raw chunk ids). */
const INTERNAL = /\b(?:point ?ids?|passage ?ids?|passages?|rubric|criteri(?:on|a)|p\d{1,2})\b|video-[a-z]+-|\btc-\d+-\d+\b/i

export {copiesPoint, LEAK_WORDS}

export function checkStructure(analysis: ExplanationAnalysis, task: ExplainTask, text: string): string[] {
  const failures: string[] = []
  if (analysis.outcome === 'off_topic') {
    if (analysis.criteria.length > 0) failures.push('off_topic with criteria')
    if (analysis.followUpQuestion !== null) failures.push('off_topic with a follow-up')
    return failures
  }
  const ids = analysis.criteria.map((criterion) => criterion.criterionId)
  if (ids.join() !== task.criteria.map((criterion) => criterion.id).join()) failures.push(`criteria ${ids.join(',')} are not the task's, in order`)
  for (const judged of analysis.criteria) {
    const criterion = task.criteria.find((entry) => entry.id === judged.criterionId)
    if (!criterion) continue
    const at = judged.criterionId
    if (judged.span && !(judged.span.start >= 0 && judged.span.end <= text.length && judged.span.end > judged.span.start)) failures.push(`${at}: span outside the text`)
    if ((judged.status === 'missing' || judged.status === 'not_validated') && judged.span) failures.push(`${at}: ${judged.status} with a span`)
    if ((judged.status === 'demonstrated' || judged.status === 'contradicted') && !judged.span) failures.push(`${at}: ${judged.status} without a span`)
    if (judged.status === 'contradicted' && judged.citations.length === 0) failures.push(`${at}: contradicted without a citation`)
    const allowed = new Set(criterion.sources.map((chunk) => chunk.chunkId))
    if (judged.citations.some((citation) => !allowed.has(citation.chunkId))) failures.push(`${at}: cites outside its sources`)
    if (judged.feedback && INTERNAL.test(judged.feedback)) failures.push(`${at}: internal reference in feedback`)
    for (const other of task.criteria) {
      if (judged.feedback && copiesPoint(judged.feedback, other.point)) failures.push(`${at}: feedback copies a private point`)
    }
  }
  const question = analysis.followUpQuestion
  if (question !== null && (!question.trim().endsWith('?') || INTERNAL.test(question))) failures.push('follow-up is not one clean question')
  if (question && task.criteria.some((criterion) => copiesPoint(question, criterion.point))) failures.push('follow-up copies a private point')
  return failures
}

export function checkExpectations(analysis: ExplanationAnalysis, expect: ExplainExpectation): string[] {
  const failures: string[] = []
  if (!expect.outcome.includes(analysis.outcome)) failures.push(`outcome ${analysis.outcome} not in [${expect.outcome.join(', ')}]`)
  for (const [criterionId, allowed] of Object.entries(expect.criteria)) {
    const judged = analysis.criteria.find((criterion) => criterion.criterionId === criterionId)
    // An off-topic outcome judges nothing; it is checked by `outcome`.
    if (!judged) {
      if (analysis.outcome === 'assessed') failures.push(`${criterionId}: not judged`)
      continue
    }
    if (!allowed.includes(judged.status)) failures.push(`${criterionId}: ${judged.status} not in [${allowed.join(', ')}]`)
  }
  for (const judged of analysis.criteria) {
    if (expect.forbidStatuses.includes(judged.status)) failures.push(`${judged.criterionId}: forbidden ${judged.status}`)
  }
  if (expect.followUp === 'required' && !analysis.followUpQuestion) failures.push('no follow-up question')
  return failures
}
