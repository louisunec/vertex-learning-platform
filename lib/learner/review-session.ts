import type postgres from 'postgres'

import type {CheckCandidate} from '../assessments/learner.ts'
import {conceptDocumentId} from '../concepts/cluster.ts'
import {resolveConcept, type ConceptNode} from '../concepts/resolve.ts'
import {asLearner, type LearnerTx} from '../db/learner-scope.ts'
import {lessonMomentHref, RECENT_EVIDENCE_DAYS} from '../knowledge-map.ts'
import {
  MAX_REVIEW_CONCEPTS,
  MAX_REVIEW_ITEMS,
  REVIEW_REASONS,
  reviewRefresherResponseSchema,
  reviewSessionResponseSchema,
  type IssueTaskResponse,
  type REVIEW_NONE_REASONS,
  type ReviewItem,
  type ReviewReason,
  type ReviewRefresherRequest,
  type ReviewRefresherResponse,
  type ReviewSessionResponse,
} from './contracts.ts'
import type {LearnerContentSource} from './content-source.ts'
import {findHelpEventByKey, insertHelpEvent, lockLearnerFamily, SOURCE_REFRESHER_REASON} from './help-events.ts'
import {insertTaskInstance, matchesDelivery, TASK_INSTANCE_TTL_MS, type TaskInstanceRow} from './task-instances.ts'

/**
 * Focused review (prompts/focused-review.md): a short, server-chosen session
 * of reviewed questions on concepts the learner recently got wrong or
 * answered with help. It is not a spaced-repetition scheduler: nothing here
 * is "due", and no scheduler state is stored.
 *
 * - A concept qualifies when its latest counted attempt (independent or
 *   assisted) within `MISTAKE_WINDOW_DAYS` was not an independent correct
 *   answer. Concepts merged since grading pass their attempts to their
 *   successor; split or withdrawn concepts are left out.
 * - Each concept gets up to `MAX_ITEMS_PER_CONCEPT` approved families the
 *   learner has never answered, so an unassisted answer is new independent
 *   evidence (`evidence.ts`). A concept with none is dropped rather than
 *   repeating a question.
 * - The session pins its items as task instances in one transaction, under
 *   a per-learner lock, so a reload or a second tab resumes it instead of
 *   starting another. Progress is whether each instance has an
 *   `attempt_log` row, never a client claim.
 *
 * Learner rows are read and written in `asLearner`; Sanity reads happen
 * outside any transaction.
 */

export const REVIEW_POLICY_VERSION = 'review-v1'
export const MISTAKE_WINDOW_DAYS = RECENT_EVIDENCE_DAYS
export const MAX_ITEMS_PER_CONCEPT = 2
/** Mistake concepts whose items are read before filtering for unseen ones; bounds the Sanity read. */
export const MAX_MISTAKE_CONCEPTS = 10
/** Latest-attempt rows read for one request (one per stored concept id). */
const MISTAKE_ROW_LIMIT = 200

const DAY_MS = 24 * 60 * 60 * 1000

/* ---------- Selection (pure) ---------- */

/** The learner's latest counted attempt on one stored concept id. */
export type LatestCounted = {conceptId: string; correct: boolean; evidenceKind: 'independent' | 'assisted'; createdAt: Date}

export function reviewReason({correct, evidenceKind}: Pick<LatestCounted, 'correct' | 'evidenceKind'>): ReviewReason | null {
  if (evidenceKind === 'independent') return correct ? null : 'independent_incorrect'
  return correct ? 'assisted_correct' : 'assisted_incorrect'
}

export type Mistake = {
  /** The active concept's document id. */
  conceptDocId: string
  /** Its stable id, as stored in the session. */
  conceptId: string
  reason: ReviewReason
  at: Date
}

/** Concepts to review, most urgent reason first, then most recent, at most `MAX_MISTAKE_CONCEPTS`. */
export function pickMistakes(rows: ReadonlyArray<LatestCounted>, index: ReadonlyMap<string, ConceptNode>, now: Date): Mistake[] {
  const cutoff = now.getTime() - MISTAKE_WINDOW_DAYS * DAY_MS
  const latest = new Map<string, {row: LatestCounted; conceptId: string}>()
  for (const row of rows) {
    if (row.createdAt.getTime() < cutoff) continue
    const resolved = resolveConcept(conceptDocumentId(row.conceptId), index)
    if (resolved.status !== 'active') continue
    const current = latest.get(resolved.id)
    if (!current || row.createdAt > current.row.createdAt) latest.set(resolved.id, {row, conceptId: resolved.conceptId})
  }
  const mistakes: Mistake[] = []
  for (const [conceptDocId, {row, conceptId}] of latest) {
    const reason = reviewReason(row)
    if (reason) mistakes.push({conceptDocId, conceptId, reason, at: row.createdAt})
  }
  return mistakes
    .toSorted(
      (a, b) =>
        REVIEW_REASONS.indexOf(a.reason) - REVIEW_REASONS.indexOf(b.reason) ||
        b.at.getTime() - a.at.getTime() ||
        a.conceptId.localeCompare(b.conceptId),
    )
    .slice(0, MAX_MISTAKE_CONCEPTS)
}

/** Concept document ids whose items review the given active concepts: each one and those merged into it. */
export function conceptRefsFor(conceptDocIds: ReadonlyArray<string>, index: ReadonlyMap<string, ConceptNode>): string[] {
  const wanted = new Set(conceptDocIds)
  const refs = new Set(conceptDocIds)
  for (const node of index.values()) {
    const resolved = resolveConcept(node.id, index)
    if (resolved.status === 'active' && wanted.has(resolved.id)) refs.add(node.id)
  }
  return [...refs].toSorted()
}

type NoneReason = (typeof REVIEW_NONE_REASONS)[number]

export type PlannedItem = {mistake: Mistake; candidate: CheckCandidate}

export type SessionPlan = {status: 'planned'; items: PlannedItem[]} | {status: 'none'; reason: NoneReason}

function compareSeconds(a: number | null, b: number | null): number {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  return a - b
}

/**
 * The session's items: for each mistake in order, its unseen families by
 * earliest cited second, until `MAX_REVIEW_CONCEPTS` concepts or
 * `MAX_REVIEW_ITEMS` items.
 */
export function planSession(
  mistakes: ReadonlyArray<Mistake>,
  candidates: ReadonlyArray<CheckCandidate>,
  index: ReadonlyMap<string, ConceptNode>,
  answeredFamilies: ReadonlySet<string>,
): SessionPlan {
  if (mistakes.length === 0) return {status: 'none', reason: 'no_recent_mistakes'}

  const unseen = new Map<string, CheckCandidate[]>()
  const families = new Set<string>()
  const ordered = candidates.toSorted(
    (a, b) => compareSeconds(a.firstSeconds, b.firstSeconds) || a.item.familyId.localeCompare(b.item.familyId),
  )
  for (const candidate of ordered) {
    const {familyId} = candidate.item
    if (!candidate.primaryConceptRef || answeredFamilies.has(familyId) || families.has(familyId)) continue
    const resolved = resolveConcept(candidate.primaryConceptRef, index)
    if (resolved.status !== 'active') continue
    families.add(familyId)
    unseen.set(resolved.id, [...(unseen.get(resolved.id) ?? []), candidate])
  }

  const items: PlannedItem[] = []
  let concepts = 0
  for (const mistake of mistakes) {
    if (concepts >= MAX_REVIEW_CONCEPTS || items.length >= MAX_REVIEW_ITEMS) break
    const picked = (unseen.get(mistake.conceptDocId) ?? []).slice(0, Math.min(MAX_ITEMS_PER_CONCEPT, MAX_REVIEW_ITEMS - items.length))
    if (picked.length === 0) continue
    concepts += 1
    items.push(...picked.map((candidate) => ({mistake, candidate})))
  }
  return items.length > 0 ? {status: 'planned', items} : {status: 'none', reason: 'no_unseen_questions'}
}

/* ---------- Learner rows ---------- */

type StoredItem = {
  position: number
  conceptId: string
  reason: ReviewReason
  sourceSeconds: number | null
  answered: boolean
  instance: TaskInstanceRow
}

type StoredSession = {id: string; expiresAt: Date; items: StoredItem[]}

/** Serializes starting a review for one learner, so two tabs can't create two sessions. */
async function lockLearnerReviews(tx: LearnerTx, learnerId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended(${`review:${learnerId}`}, 0))`
}

async function readLatestCounted(tx: LearnerTx, learnerId: string, since: Date): Promise<LatestCounted[]> {
  const rows = await tx<LatestCounted[]>`
    select distinct on (resolved_concept_id)
           resolved_concept_id as "conceptId", correct, evidence_kind as "evidenceKind", created_at as "createdAt"
    from learner.attempt_log
    where learner_id = ${learnerId} and resolved_concept_id is not null
      and evidence_kind in ('independent', 'assisted') and created_at >= ${since}
    order by resolved_concept_id, created_at desc, id desc
    limit ${MISTAKE_ROW_LIMIT}
  `
  return [...rows]
}

async function readAnsweredFamilies(tx: LearnerTx, learnerId: string, familyIds: string[]): Promise<Set<string>> {
  if (familyIds.length === 0) return new Set()
  const rows = await tx<{familyId: string}[]>`
    select distinct family_id as "familyId" from learner.attempt_log
    where learner_id = ${learnerId} and family_id = any(${tx.array(familyIds)})
  `
  return new Set(rows.map((row) => row.familyId))
}

/** The learner's newest unexpired session that still has an unanswered item, with its items in order. */
async function findActiveSession(tx: LearnerTx, learnerId: string, now: Date): Promise<StoredSession | null> {
  const [session] = await tx<{id: string; expiresAt: Date}[]>`
    select s.id, s.expires_at as "expiresAt"
    from learner.review_session s
    where s.learner_id = ${learnerId} and s.expires_at > ${now}
      and exists (
        select 1 from learner.review_session_item i
        where i.session_id = s.id
          and not exists (select 1 from learner.attempt_log a where a.task_instance_id = i.task_instance_id)
      )
    order by s.created_at desc, s.id desc
    limit 1
  `
  if (!session) return null
  const rows = await tx<(Omit<StoredItem, 'instance'> & TaskInstanceRow)[]>`
    select
      i.position, i.concept_id as "conceptId", i.reason, i.source_seconds as "sourceSeconds",
      exists (select 1 from learner.attempt_log a where a.task_instance_id = i.task_instance_id) as answered,
      t.id, t.learner_id as "learnerId", t.assessment_id as "assessmentId", t.family_id as "familyId",
      t.assessment_version as "assessmentVersion", t.lesson_id as "lessonId",
      t.delivered_option_ids as "deliveredOptionIds", t.expires_at as "expiresAt"
    from learner.review_session_item i
    join learner.task_instance t on t.id = i.task_instance_id
    where i.session_id = ${session.id} and i.learner_id = ${learnerId}
    order by i.position
  `
  return {
    ...session,
    items: rows.map(({position, conceptId, reason, sourceSeconds, answered, ...instance}) => ({
      position,
      conceptId,
      reason,
      sourceSeconds,
      answered,
      instance,
    })),
  }
}

/* ---------- Sessions ---------- */

const none = (reason: NoneReason): ReviewSessionResponse => ({status: 'none', reason})

type Created = {status: 'created'; session: StoredSession; resumed: boolean; issued: ReadonlyMap<string, IssueTaskResponse>}

/**
 * The learner's unfinished review, or a new one built from their recent
 * mistakes, or the reason there is none. `learnerId` is always the Clerk
 * user id from `auth()`.
 */
export async function startReviewSession({
  db,
  content,
  learnerId,
  now,
}: {
  db: postgres.Sql
  content: LearnerContentSource
  learnerId: string
  now: Date
}): Promise<ReviewSessionResponse> {
  const since = new Date(now.getTime() - MISTAKE_WINDOW_DAYS * DAY_MS)
  const first = await asLearner(db, learnerId, async (tx): Promise<StoredSession | LatestCounted[]> => {
    return (await findActiveSession(tx, learnerId, now)) ?? readLatestCounted(tx, learnerId, since)
  })
  if (!Array.isArray(first)) return presentSession(content, first, true, new Map())

  const index = await content.loadConceptIndex()
  const mistakes = pickMistakes(first, index, now)
  if (mistakes.length === 0) return none('no_recent_mistakes')
  const candidates = await content.loadReviewCandidates(conceptRefsFor(mistakes.map((mistake) => mistake.conceptDocId), index))

  const created = await asLearner(db, learnerId, async (tx): Promise<Created | {status: 'none'; reason: NoneReason}> => {
    await lockLearnerReviews(tx, learnerId)
    // Another tab started one after the first read.
    const active = await findActiveSession(tx, learnerId, now)
    if (active) return {status: 'created', session: active, resumed: true, issued: new Map()}

    const families = [...new Set(candidates.map((candidate) => candidate.item.familyId))]
    const plan = planSession(mistakes, candidates, index, await readAnsweredFamilies(tx, learnerId, families))
    if (plan.status === 'none') return plan

    const expiresAt = new Date(now.getTime() + TASK_INSTANCE_TTL_MS)
    const [session] = await tx<{id: string}[]>`
      insert into learner.review_session (learner_id, policy_version, created_at, expires_at)
      values (${learnerId}, ${REVIEW_POLICY_VERSION}, ${now}, ${expiresAt})
      returning id
    `
    const issued = new Map<string, IssueTaskResponse>()
    const items: StoredItem[] = []
    for (const [i, {mistake, candidate}] of plan.items.entries()) {
      const task = await insertTaskInstance(tx, learnerId, candidate.item, now)
      const sourceSeconds = candidate.firstSeconds === null ? null : Math.floor(candidate.firstSeconds)
      await tx`
        insert into learner.review_session_item
          (session_id, learner_id, position, concept_id, reason, task_instance_id, source_seconds)
        values (${session.id}, ${learnerId}, ${i + 1}, ${mistake.conceptId}, ${mistake.reason}, ${task.taskInstanceId}, ${sourceSeconds})
      `
      issued.set(task.taskInstanceId, task)
      items.push({
        position: i + 1,
        conceptId: mistake.conceptId,
        reason: mistake.reason,
        sourceSeconds,
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
    return {status: 'created', session: {id: session.id, expiresAt, items}, resumed: false, issued}
  })
  if (created.status === 'none') return none(created.reason)
  return presentSession(content, created.session, created.resumed, created.issued)
}

/**
 * The response for a stored session. An open item's task is the one just
 * issued, or on resume the published item re-read and checked against what
 * the instance delivered; a withdrawn or changed item is `unavailable`.
 */
async function presentSession(
  content: LearnerContentSource,
  session: StoredSession,
  resumed: boolean,
  issued: ReadonlyMap<string, IssueTaskResponse>,
): Promise<ReviewSessionResponse> {
  const open = session.items.filter((item) => !item.answered)
  const tasks = new Map(
    await Promise.all(
      open.map(async ({instance}): Promise<[string, IssueTaskResponse | null]> => {
        const fresh = issued.get(instance.id)
        if (fresh) return [instance.id, fresh]
        const item = await content.loadServableItem(instance.assessmentId)
        const delivered = item && matchesDelivery({...item, optionIds: item.options.map((option) => option.id)}, instance)
        return [instance.id, delivered ? {taskInstanceId: instance.id, expiresAt: instance.expiresAt.toISOString(), item} : null]
      }),
    ),
  )

  const index = await content.loadConceptIndex()
  const conceptIds = [...new Set(session.items.map((item) => item.conceptId))]
  const docIds = new Map(
    conceptIds.map((conceptId) => {
      const resolved = resolveConcept(conceptDocumentId(conceptId), index)
      return [conceptId, resolved.status === 'active' ? resolved.id : null]
    }),
  )
  const withSource = open.filter((item) => item.sourceSeconds !== null && tasks.get(item.instance.id))
  const [names, lessons] = await Promise.all([
    content.loadConceptNames([...new Set([...docIds.values()].filter((id): id is string => id !== null))]),
    content.loadLessons([...new Set(withSource.map((item) => item.instance.lessonId))]),
  ])

  const items: ReviewItem[] = session.items.map((item) => {
    const base = {position: item.position, conceptId: item.conceptId}
    if (item.answered) return {...base, state: 'answered'}
    const task = tasks.get(item.instance.id)
    if (!task) return {...base, state: 'unavailable'}
    const lesson = lessons.get(item.instance.lessonId)
    const refresher =
      item.sourceSeconds !== null && lesson ? {lessonTitle: lesson.title, startSeconds: item.sourceSeconds} : null
    return {...base, state: 'open', task, refresher}
  })
  const concepts = conceptIds.map((conceptId) => {
    const docId = docIds.get(conceptId)
    return {
      conceptId,
      name: (docId && names.get(docId)) || null,
      reason: session.items.find((item) => item.conceptId === conceptId)!.reason,
    }
  })

  return reviewSessionResponseSchema.parse({
    status: 'active',
    sessionId: session.id,
    expiresAt: session.expiresAt.toISOString(),
    resumed,
    concepts,
    items,
  })
}

/* ---------- Refresher ---------- */

export type RefresherRejection = 'not_found' | 'idempotency_key_reused'

export type OpenRefresherOutcome =
  | {status: 'recorded'; body: ReviewRefresherResponse}
  | {status: 'rejected'; code: RefresherRejection}

const rejected = (code: RefresherRejection): OpenRefresherOutcome => ({status: 'rejected', code})

/**
 * The lesson moment a review item cites, recorded first as level-1 help on
 * its task instance (reason `source_refresher`): the source can give the
 * answer away, so an answer after it counts as assisted, like one after a
 * hint. It does not advance the hint ladder (`getInstanceHelpLevel`). Only
 * items of the learner's own sessions have a refresher; a retry with the
 * same key returns the first event and records nothing more.
 */
export async function openRefresher({
  db,
  content,
  learnerId,
  request,
}: {
  db: postgres.Sql
  content: LearnerContentSource
  learnerId: string
  request: ReviewRefresherRequest
}): Promise<OpenRefresherOutcome> {
  const found = await asLearner(db, learnerId, async (tx) => {
    const [item] = await tx<{familyId: string; lessonId: string; sourceSeconds: number | null}[]>`
      select t.family_id as "familyId", t.lesson_id as "lessonId", i.source_seconds as "sourceSeconds"
      from learner.review_session_item i
      join learner.task_instance t on t.id = i.task_instance_id
      where i.task_instance_id = ${request.taskInstanceId} and i.learner_id = ${learnerId}
    `
    return item ? {item, stored: await findHelpEventByKey(tx, learnerId, request.requestKey)} : null
  })
  if (!found || found.item.sourceSeconds === null) return rejected('not_found')
  const {item, stored} = found
  const sameRequest = (event: {taskInstanceId: string | null; reasonCode: string}) =>
    event.taskInstanceId === request.taskInstanceId && event.reasonCode === SOURCE_REFRESHER_REASON
  if (stored && !sameRequest(stored)) return rejected('idempotency_key_reused')

  // An unpublished lesson has no page to open: nothing is recorded.
  const lesson = (await content.loadLessons([item.lessonId])).get(item.lessonId)
  if (!lesson) return rejected('not_found')
  const href = lessonMomentHref(lesson.slug, item.sourceSeconds!)
  const recorded = (helpEventId: string, replayed: boolean): OpenRefresherOutcome => ({
    status: 'recorded',
    body: reviewRefresherResponseSchema.parse({helpEventId, href, replayed}),
  })
  if (stored) return recorded(stored.id, true)

  const event = await asLearner(db, learnerId, async (tx) => {
    // The same lock as grading, so an answer submitted meanwhile sees this help.
    await lockLearnerFamily(tx, learnerId, item.familyId)
    const inserted = await insertHelpEvent(tx, learnerId, {
      requestKey: request.requestKey,
      taskInstanceId: request.taskInstanceId,
      level: 1,
      policyVersion: REVIEW_POLICY_VERSION,
      reasonCode: SOURCE_REFRESHER_REASON,
    })
    if (inserted.status !== 'recorded') return null
    if (!inserted.replayed) return {id: inserted.id, replayed: false}
    // A concurrent request with this key committed first.
    const earlier = await findHelpEventByKey(tx, learnerId, request.requestKey)
    return earlier && sameRequest(earlier) ? {id: earlier.id, replayed: true} : 'reused'
  })
  if (event === 'reused') return rejected('idempotency_key_reused')
  return event ? recorded(event.id, event.replayed) : rejected('not_found')
}
