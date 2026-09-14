import type postgres from 'postgres'

import type {CheckCandidate} from '../assessments/learner.ts'
import {conceptDocumentId} from '../concepts/cluster.ts'
import {resolveConcept, type ConceptNode} from '../concepts/resolve.ts'
import {asLearner, type LearnerTx} from '../db/learner-scope.ts'
import {readDueCards, readDueSummary, type CardRow} from '../review/cards.ts'
import {
  MAX_REVIEW_ITEMS,
  SCHEDULED_DUE,
  scheduledReviewResponseSchema,
  type IssueTaskResponse,
  type ScheduledReviewResponse,
  type SCHEDULED_NONE_REASONS,
} from './contracts.ts'
import type {LearnerContentSource} from './content-source.ts'
import {conceptRefsFor, findActiveSession, lockLearnerReviews, presentItems, type StoredItem, type StoredSession} from './review-session.ts'
import {insertTaskInstance, TASK_INSTANCE_TTL_MS} from './task-instances.ts'

/**
 * Scheduled review (development plan §5 PR-9, prompts/pr-9-scheduled-review.md):
 * the Reviews page's second mode, beside the Mistakes focused review. It
 * serves the learner's FSRS cards that are due, one item per card, oldest
 * due first, at most `MAX_REVIEW_ITEMS`. Grading updates the cards
 * (`attempts.ts`); this module only chooses and pins what to ask.
 *
 * - An item matches a card when its primary concept resolves to the card's
 *   concept (through merges) and its reviewed type is the card's type.
 * - A family the learner never answered is preferred; otherwise the one they
 *   answered longest ago, marked `repeat`. A due card with no servable item
 *   is left unchanged and counted, never given a substitute.
 * - Sessions are stored and resumed like Mistakes sessions, in their own
 *   mode, under the same per-learner lock.
 */

export const SCHEDULED_POLICY_VERSION = 'scheduled-review-v1'
/** Due cards read per request; the session takes at most `MAX_REVIEW_ITEMS` of them. */
export const MAX_DUE_CARDS_READ = 25

type NoneReason = (typeof SCHEDULED_NONE_REASONS)[number]

/* ---------- Selection (pure) ---------- */

export type DueCard = Pick<CardRow, 'id' | 'conceptId' | 'taskType' | 'due'>

export type ScheduledItem = {card: DueCard; candidate: CheckCandidate; repeat: boolean}

export type ScheduledPlan = {items: ScheduledItem[]; unavailable: number}

function compareSeconds(a: number | null, b: number | null): number {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  return a - b
}

/**
 * One item per due card, in due order. `lastAnswered` holds, per family, when
 * the learner last answered it; families absent from it were never answered.
 */
export function planScheduled(
  cards: ReadonlyArray<DueCard>,
  candidates: ReadonlyArray<CheckCandidate>,
  index: ReadonlyMap<string, ConceptNode>,
  lastAnswered: ReadonlyMap<string, Date>,
): ScheduledPlan {
  const byConcept = new Map<string, CheckCandidate[]>()
  for (const candidate of candidates) {
    if (!candidate.primaryConceptRef) continue
    const resolved = resolveConcept(candidate.primaryConceptRef, index)
    if (resolved.status !== 'active') continue
    byConcept.set(resolved.id, [...(byConcept.get(resolved.id) ?? []), candidate])
  }

  const items: ScheduledItem[] = []
  const used = new Set<string>()
  let unavailable = 0
  const ordered = cards.toSorted((a, b) => a.due.getTime() - b.due.getTime() || a.id.localeCompare(b.id))
  for (const card of ordered) {
    if (items.length >= MAX_REVIEW_ITEMS) break
    const resolved = resolveConcept(conceptDocumentId(card.conceptId), index)
    const pool =
      resolved.status === 'active'
        ? (byConcept.get(resolved.id) ?? []).filter((candidate) => candidate.item.type === card.taskType && !used.has(candidate.item.familyId))
        : []
    const unseen = pool
      .filter((candidate) => !lastAnswered.has(candidate.item.familyId))
      .toSorted((a, b) => compareSeconds(a.firstSeconds, b.firstSeconds) || a.item.familyId.localeCompare(b.item.familyId))
    const seen = pool
      .filter((candidate) => lastAnswered.has(candidate.item.familyId))
      .toSorted(
        (a, b) =>
          lastAnswered.get(a.item.familyId)!.getTime() - lastAnswered.get(b.item.familyId)!.getTime() ||
          a.item.familyId.localeCompare(b.item.familyId),
      )
    const picked = unseen[0] ?? seen[0]
    if (!picked) {
      unavailable += 1
      continue
    }
    used.add(picked.item.familyId)
    items.push({card, candidate: picked, repeat: !unseen[0]})
  }
  return {items, unavailable}
}

/* ---------- Learner rows ---------- */

async function readLastAnswered(tx: LearnerTx, learnerId: string, familyIds: string[]): Promise<Map<string, Date>> {
  if (familyIds.length === 0) return new Map()
  const rows = await tx<{familyId: string; at: Date}[]>`
    select family_id as "familyId", max(created_at) as at from learner.attempt_log
    where learner_id = ${learnerId} and family_id = any(${tx.array(familyIds)})
    group by family_id
  `
  return new Map(rows.map((row) => [row.familyId, row.at]))
}

/* ---------- Sessions ---------- */

type Built =
  | {status: 'created'; session: StoredSession; resumed: boolean; issued: ReadonlyMap<string, IssueTaskResponse>; unavailable: number}
  | {status: 'none'; reason: NoneReason; nextDueAt: Date | null; unavailable: number}

function none(reason: NoneReason, nextDueAt: Date | null, unavailable: number): ScheduledReviewResponse {
  return scheduledReviewResponseSchema.parse({
    status: 'none',
    mode: 'scheduled',
    reason,
    nextDueAt: nextDueAt?.toISOString() ?? null,
    unavailableDue: unavailable,
  })
}

/**
 * The learner's unfinished scheduled review, or a new one over their due
 * cards, or the reason there is none (with when the next card falls due).
 * `learnerId` is always the Clerk user id from `auth()`.
 */
export async function startScheduledReview({
  db,
  content,
  learnerId,
  now,
}: {
  db: postgres.Sql
  content: LearnerContentSource
  learnerId: string
  now: Date
}): Promise<ScheduledReviewResponse> {
  const first = await asLearner(db, learnerId, async (tx) => {
    const active = await findActiveSession(tx, learnerId, now, 'scheduled')
    if (active) return active
    const cards = await readDueCards(tx, learnerId, now, MAX_DUE_CARDS_READ)
    return cards.length > 0 ? cards : {nextDueAt: (await readDueSummary(tx, learnerId, now)).nextDueAt}
  })
  if ('items' in first) return presentScheduled(content, first, true, new Map(), 0)
  if (!Array.isArray(first)) return none('nothing_due', first.nextDueAt, 0)
  const cards = first

  const index = await content.loadConceptIndex()
  const active = new Set<string>()
  for (const card of cards) {
    const resolved = resolveConcept(conceptDocumentId(card.conceptId), index)
    if (resolved.status === 'active') active.add(resolved.id)
  }
  const candidates = active.size > 0 ? await content.loadReviewCandidates(conceptRefsFor([...active], index)) : []

  const built = await asLearner(db, learnerId, async (tx): Promise<Built> => {
    await lockLearnerReviews(tx, learnerId)
    // Another tab started one after the first read.
    const resumed = await findActiveSession(tx, learnerId, now, 'scheduled')
    if (resumed) return {status: 'created', session: resumed, resumed: true, issued: new Map(), unavailable: 0}

    const families = [...new Set(candidates.map((candidate) => candidate.item.familyId))]
    const plan = planScheduled(cards, candidates, index, await readLastAnswered(tx, learnerId, families))
    if (plan.items.length === 0) {
      const {nextDueAt} = await readDueSummary(tx, learnerId, now)
      return {status: 'none', reason: 'no_scheduled_questions', nextDueAt, unavailable: plan.unavailable}
    }

    const expiresAt = new Date(now.getTime() + TASK_INSTANCE_TTL_MS)
    const [session] = await tx<{id: string}[]>`
      insert into learner.review_session (learner_id, policy_version, mode, created_at, expires_at)
      values (${learnerId}, ${SCHEDULED_POLICY_VERSION}, 'scheduled', ${now}, ${expiresAt})
      returning id
    `
    const issued = new Map<string, IssueTaskResponse>()
    const items: StoredItem[] = []
    for (const [i, {card, candidate, repeat}] of plan.items.entries()) {
      const task = await insertTaskInstance(tx, learnerId, candidate.item, now)
      const sourceSeconds = candidate.firstSeconds === null ? null : Math.floor(candidate.firstSeconds)
      await tx`
        insert into learner.review_session_item
          (session_id, learner_id, position, concept_id, reason, task_instance_id, source_seconds, card_id, repeat)
        values (
          ${session.id}, ${learnerId}, ${i + 1}, ${card.conceptId}, ${SCHEDULED_DUE}, ${task.taskInstanceId},
          ${sourceSeconds}, ${card.id}, ${repeat}
        )
      `
      issued.set(task.taskInstanceId, task)
      items.push({
        position: i + 1,
        conceptId: card.conceptId,
        reason: SCHEDULED_DUE,
        sourceSeconds,
        repeat,
        answered: false,
        instance: {
          id: task.taskInstanceId,
          learnerId,
          assessmentId: candidate.item._id,
          familyId: candidate.item.familyId,
          assessmentVersion: candidate.item.version,
          lessonId: candidate.item.lessonId,
          deliveredOptionIds: candidate.item.options.map((option) => option.id),
          expiresAt,
        },
      })
    }
    return {status: 'created', session: {id: session.id, expiresAt, items}, resumed: false, issued, unavailable: plan.unavailable}
  })
  if (built.status === 'none') return none(built.reason, built.nextDueAt, built.unavailable)
  return presentScheduled(content, built.session, built.resumed, built.issued, built.unavailable)
}

/** `unavailable` is counted when a session is built; a resumed one reports 0. */
async function presentScheduled(
  content: LearnerContentSource,
  session: StoredSession,
  resumed: boolean,
  issued: ReadonlyMap<string, IssueTaskResponse>,
  unavailable: number,
): Promise<ScheduledReviewResponse> {
  const {items, concepts} = await presentItems(content, session, issued)
  return scheduledReviewResponseSchema.parse({
    status: 'active',
    mode: 'scheduled',
    sessionId: session.id,
    expiresAt: session.expiresAt.toISOString(),
    resumed,
    concepts: concepts.map((concept) => ({...concept, reason: SCHEDULED_DUE})),
    items: items.map((item) =>
      item.state === 'open' ? {...item, repeat: session.items.find((stored) => stored.position === item.position)!.repeat} : item,
    ),
    unavailableDue: unavailable,
  })
}
