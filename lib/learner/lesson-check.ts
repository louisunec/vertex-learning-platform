import type postgres from 'postgres'

import type {CheckCandidate} from '../assessments/learner.ts'
import {resolveConcept, type ConceptNode} from '../concepts/resolve.ts'
import {asLearner} from '../db/learner-scope.ts'
import {
  issueTaskResponseSchema,
  lessonCheckResponseSchema,
  type LESSON_CHECK_NONE_REASONS,
  type LessonCheckRequest,
  type LessonCheckResponse,
} from './contracts.ts'
import {ContentUnavailableError, type LearnerContentSource} from './content-source.ts'
import {findOwnedTaskInstance, issueTask, matchesDelivery, type TaskInstanceRow} from './task-instances.ts'

/**
 * Server-side question selection for a lesson's understanding check
 * (development plan §5 PR-7). The client never names an assessment.
 *
 * A lesson's servable items are grouped by their resolved primary concept
 * (merges redirect; an item without an active concept is a group of its
 * own), in lesson order by earliest cited second.
 *
 * - `check` issues the first family of the first group in which the learner
 *   has answered nothing, so same-concept siblings stay in reserve.
 * - `follow_up` issues a sibling of an answered task: another family on the
 *   same concept that the learner has never answered. That is the "unseen
 *   reviewed variant" whose first unassisted answer is independent evidence
 *   (`evidence.ts`). No concept or no sibling is an unavailable state, never
 *   evidence.
 *
 * "Answered" means an `attempt_log` row, the same fact the evidence policy
 * uses. An unexpired, unanswered instance of the chosen item is handed back
 * instead of issuing a duplicate. Learner rows are read in `asLearner`;
 * Sanity reads happen outside any transaction.
 */

type NoneReason = (typeof LESSON_CHECK_NONE_REASONS)[number]

export type CheckGroup = {
  /** The resolved active concept id, or null for an item without one (a group of one family). */
  conceptId: string | null
  /** In lesson order. */
  candidates: CheckCandidate[]
}

function compareSeconds(a: number | null, b: number | null): number {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  return a - b
}

const compareCandidates = (a: CheckCandidate, b: CheckCandidate) =>
  compareSeconds(a.firstSeconds, b.firstSeconds) || a.item.familyId.localeCompare(b.item.familyId)

/** Groups candidates by resolved concept; groups come out ordered by their earliest candidate. */
export function groupCandidates(candidates: readonly CheckCandidate[], concepts: ReadonlyMap<string, ConceptNode>): CheckGroup[] {
  const groups = new Map<string, CheckGroup>()
  for (const candidate of candidates.toSorted(compareCandidates)) {
    const resolution = candidate.primaryConceptRef ? resolveConcept(candidate.primaryConceptRef, concepts) : null
    const conceptId = resolution?.status === 'active' ? resolution.conceptId : null
    const key = conceptId ? `concept:${conceptId}` : `family:${candidate.item.familyId}`
    const group = groups.get(key)
    if (group) group.candidates.push(candidate)
    else groups.set(key, {conceptId, candidates: [candidate]})
  }
  return [...groups.values()]
}

export type Selection =
  | {status: 'selected'; candidate: CheckCandidate; progress: {remaining: number; total: number} | null}
  | {status: 'none'; reason: NoneReason}

const none = (reason: NoneReason): Selection => ({status: 'none', reason})

/** The next check question: the first family of the first group with nothing answered. */
export function selectCheckItem(groups: readonly CheckGroup[], answered: ReadonlySet<string>): Selection {
  if (groups.length === 0) return none('no_items')
  const open = groups.filter((group) => group.candidates.every((candidate) => !answered.has(candidate.item.familyId)))
  if (open.length === 0) return none('all_checked')
  return {status: 'selected', candidate: open[0].candidates[0], progress: {remaining: open.length, total: groups.length}}
}

/** An unanswered family on the same concept as `answeredFamilyId`, when the item has a concept and one exists. */
export function selectFollowUp(groups: readonly CheckGroup[], answered: ReadonlySet<string>, answeredFamilyId: string): Selection {
  const group = groups.find((entry) => entry.candidates.some((candidate) => candidate.item.familyId === answeredFamilyId))
  if (!group?.conceptId) return none('no_variant')
  const variant = group.candidates.find(
    (candidate) => candidate.item.familyId !== answeredFamilyId && !answered.has(candidate.item.familyId),
  )
  return variant ? {status: 'selected', candidate: variant, progress: null} : none('no_variant')
}

export type LessonCheckRejection = 'not_found' | 'invalid_request'

export type NextLessonTaskOutcome = {status: 'ok'; body: LessonCheckResponse} | {status: 'rejected'; code: LessonCheckRejection}

type Checked = {selection: Selection; open: TaskInstanceRow | null}

export async function nextLessonTask({
  db,
  content,
  learnerId,
  request,
  now,
}: {
  db: postgres.Sql
  content: LearnerContentSource
  learnerId: string
  request: LessonCheckRequest
  now: Date
}): Promise<NextLessonTaskOutcome> {
  const candidates = await content.loadLessonCheckCandidates(request.lessonId)
  const concepts = candidates.some((candidate) => candidate.primaryConceptRef) ? await content.loadConceptIndex() : new Map()
  const groups = groupCandidates(candidates, concepts)
  const families = candidates.map((candidate) => candidate.item.familyId)

  const checked = await asLearner(db, learnerId, async (tx): Promise<Checked | LessonCheckRejection> => {
    let answeredFamilyId: string | null = null
    if (request.kind === 'follow_up') {
      const instance = await findOwnedTaskInstance(tx, learnerId, request.afterTaskInstanceId)
      if (!instance || instance.lessonId !== request.lessonId) return 'not_found'
      const [submitted] = await tx`select 1 from learner.attempt_log where task_instance_id = ${instance.id}`
      if (!submitted) return 'invalid_request'
      answeredFamilyId = instance.familyId
    }

    const answered = new Set<string>()
    if (families.length > 0) {
      const rows = await tx<{familyId: string}[]>`
        select distinct family_id as "familyId" from learner.attempt_log
        where learner_id = ${learnerId} and family_id = any(${tx.array(families)})
      `
      for (const row of rows) answered.add(row.familyId)
    }

    const selection = answeredFamilyId === null ? selectCheckItem(groups, answered) : selectFollowUp(groups, answered, answeredFamilyId)
    if (selection.status === 'none') return {selection, open: null}

    const [open] = await tx<TaskInstanceRow[]>`
      select
        id,
        learner_id as "learnerId",
        assessment_id as "assessmentId",
        family_id as "familyId",
        assessment_version as "assessmentVersion",
        lesson_id as "lessonId",
        delivered_option_ids as "deliveredOptionIds",
        expires_at as "expiresAt"
      from learner.task_instance as instance
      where learner_id = ${learnerId}
        and assessment_id = ${selection.candidate.item._id}
        and expires_at > ${now}
        and not exists (select 1 from learner.attempt_log as attempt where attempt.task_instance_id = instance.id)
      order by issued_at desc
      limit 1
    `
    return {selection, open: open ?? null}
  })
  if (typeof checked === 'string') return {status: 'rejected', code: checked}

  const {selection, open} = checked
  if (selection.status === 'none') {
    return {status: 'ok', body: lessonCheckResponseSchema.parse({status: 'none', kind: request.kind, reason: selection.reason})}
  }

  const {item} = selection.candidate
  const issued = (task: unknown, resumed: boolean): NextLessonTaskOutcome => ({
    status: 'ok',
    body: lessonCheckResponseSchema.parse({status: 'issued', kind: request.kind, task, resumed, progress: selection.progress}),
  })

  if (open && matchesDelivery({...item, optionIds: item.options.map((option) => option.id)}, open)) {
    return issued(issueTaskResponseSchema.parse({taskInstanceId: open.id, expiresAt: open.expiresAt.toISOString(), item}), true)
  }

  const outcome = await issueTask({db, content, learnerId, assessmentId: item._id, now})
  // Withdrawn between the two reads: a retry selects again from current content.
  if (outcome.status !== 'issued') throw new ContentUnavailableError('The selected check item is no longer servable')
  return issued(outcome.body, false)
}
