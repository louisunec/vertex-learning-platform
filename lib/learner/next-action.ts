import type postgres from 'postgres'

import type {CheckCandidate} from '../assessments/learner.ts'
import {conceptDocumentId} from '../concepts/cluster.ts'
import {resolveConcept, type ConceptNode} from '../concepts/resolve.ts'
import {asLearner, type LearnerTx} from '../db/learner-scope.ts'
import {evidenceIdsFor, resolveEvidence} from '../knowledge-map.ts'
import {buildPlan, NEXT_ACTION_POLICY_VERSION, type CheckOffer, type PlanLesson, type PracticeInput} from '../next-action.ts'
import {REVIEW_REASONS, type ReviewReason} from './contracts.ts'
import {readGoalTx, type LearningGoal} from './goal.ts'
import {readMapEvidence} from './knowledge-map.ts'
import {groupCandidates, selectCheckItem} from './lesson-check.ts'
import {nextActionResponseSchema, type NextActionRequest, type NextActionResponse} from './next-action-contracts.ts'
import type {GoalCourse, NextActionContentSource} from './next-action-source.ts'
import {
  conceptRefsFor,
  findActiveSession,
  MISTAKE_WINDOW_DAYS,
  pickMistakes,
  planSession,
  readAnsweredFamilies,
  readLatestCounted,
} from './review-session.ts'

/**
 * The next-action service (development plan §5 PR-11). Reads the learner's
 * goal, progress, and evidence, plus the goal course's published concepts,
 * edges, and deliverable checks and reviews, then builds the deterministic
 * plan (`lib/next-action.ts`). Read-only: nothing here writes learner
 * state, so showing or following a recommendation never changes evidence.
 *
 * Learner rows are read in `asLearner` transactions (row level security);
 * Sanity reads happen outside them. Any failed read throws, so an outage is
 * never presented as an empty plan. `learnerId` is always the Clerk user id
 * from `auth()`.
 */

/** Which delivery routes are on for this learner (flags evaluated by the caller). */
export type NextActionCapabilities = {
  /** Focused review (`review-session` + `learner-evidence`). */
  practice: boolean
  /** The lesson check (`lesson-integration` + `learner-evidence`). */
  checks: boolean
}

/** Candidates one lesson's check reads (`LESSON_CHECK_CANDIDATES_QUERY`'s bound). */
const LESSON_CHECK_LIMIT = 50

const DAY_MS = 24 * 60 * 60 * 1000

export type NextActionOutcome = {status: 'ok'; body: NextActionResponse} | {status: 'rejected'; code: 'not_found'}

type ActiveItem = {conceptId: string; reason: ReviewReason}

const isReviewReason = (reason: string): reason is ReviewReason => (REVIEW_REASONS as ReadonlyArray<string>).includes(reason)

/**
 * Open items of the learner's unfinished focused review, in order: exactly
 * the session `/my-learning/reviews` resumes, read by focused review's own
 * `findActiveSession` so both always agree on which session that is.
 */
async function readActiveReview(tx: LearnerTx, learnerId: string, now: Date): Promise<ActiveItem[]> {
  const session = await findActiveSession(tx, learnerId, now)
  return (session?.items ?? []).flatMap((item) =>
    !item.answered && isReviewReason(item.reason) ? [{conceptId: item.conceptId, reason: item.reason}] : [],
  )
}

/** The active doc id for a stored concept id, or null when it no longer resolves to one concept. */
function activeDocId(conceptId: string, index: ReadonlyMap<string, ConceptNode>): string | null {
  const resolved = resolveConcept(conceptDocumentId(conceptId), index)
  return resolved.status === 'active' ? resolved.id : null
}

/** For each lesson whose check would issue a question now: its concept and progress (PR-7's selection). */
export function checkOffers(
  lessonIds: ReadonlyArray<string>,
  candidates: ReadonlyArray<CheckCandidate>,
  index: ReadonlyMap<string, ConceptNode>,
  answered: ReadonlySet<string>,
): Map<string, CheckOffer> {
  const offers = new Map<string, CheckOffer>()
  for (const lessonId of lessonIds) {
    const own = candidates
      .filter((candidate) => candidate.item.lessonId === lessonId)
      .toSorted((a, b) => a.item.familyId.localeCompare(b.item.familyId))
      .slice(0, LESSON_CHECK_LIMIT)
    const groups = groupCandidates(own, index)
    const selection = selectCheckItem(groups, answered)
    if (selection.status !== 'selected' || !selection.progress) continue
    const group = groups.find((entry) => entry.candidates.includes(selection.candidate))
    offers.set(lessonId, {
      conceptDocId: group?.conceptId ? activeDocId(group.conceptId, index) : null,
      remaining: selection.progress.remaining,
      total: selection.progress.total,
    })
  }
  return offers
}

function toPlanLessons(course: GoalCourse): PlanLesson[] {
  return course.lessons.map((lesson, i) => ({...lesson, number: i + 1}))
}

const goalBody = (goal: LearningGoal) => ({kind: goal.kind, courseId: goal.courseId, setAt: goal.setAt.toISOString()})

export async function planNextActions({
  db,
  content,
  learnerId,
  request,
  capabilities,
  now,
}: {
  db: postgres.Sql
  content: NextActionContentSource
  learnerId: string
  request: NextActionRequest
  capabilities: NextActionCapabilities
  now: Date
}): Promise<NextActionOutcome> {
  const since = new Date(now.getTime() - MISTAKE_WINDOW_DAYS * DAY_MS)
  const learner = await asLearner(db, learnerId, async (tx) => ({
    goal: await readGoalTx(tx, learnerId),
    active: capabilities.practice ? await readActiveReview(tx, learnerId, now) : [],
    counted: capabilities.practice ? await readLatestCounted(tx, learnerId, since) : [],
  }))

  const courseId = request.courseId ?? learner.goal?.courseId
  const ok = (body: unknown): NextActionOutcome => ({status: 'ok', body: nextActionResponseSchema.parse(body)})
  if (!courseId) return ok({status: 'no_goal'})

  const course = await content.loadCourse(courseId)
  if (!course) {
    if (request.courseId) return {status: 'rejected', code: 'not_found'}
    return ok({status: 'goal_unavailable', goal: goalBody(learner.goal!)})
  }
  const lessons = toPlanLessons(course)
  const lessonIds = lessons.map((lesson) => lesson._id)

  const [progress, index, concepts, checkCandidates] = await Promise.all([
    content.loadProgress(learnerId),
    content.loadConceptIndex(),
    content.loadCourseConcepts(lessonIds),
    capabilities.checks ? content.loadCourseCheckCandidates(lessonIds) : Promise.resolve([]),
  ])
  const edges = await content.loadPrerequisiteEdges(concepts.map((concept) => concept.id))

  // What focused review would serve: the unfinished session, else the one it would build now.
  let practice: PracticeInput = {status: 'unavailable'}
  let reviewCandidates: CheckCandidate[] = []
  let mistakes: ReturnType<typeof pickMistakes> = []
  if (capabilities.practice) {
    if (learner.active.length > 0) {
      const seen = new Set<string>()
      const entries = learner.active.flatMap((item) => {
        const docId = activeDocId(item.conceptId, index)
        if (!docId || seen.has(docId)) return []
        seen.add(docId)
        return [{conceptDocId: docId, conceptId: item.conceptId, reason: item.reason}]
      })
      practice = entries.length > 0 ? {status: 'session', resumed: true, concepts: entries} : {status: 'none'}
    } else {
      mistakes = pickMistakes(learner.counted, index, now)
      reviewCandidates =
        mistakes.length > 0 ? await content.loadReviewCandidates(conceptRefsFor(mistakes.map((mistake) => mistake.conceptDocId), index)) : []
      practice = {status: 'none'}
    }
  }

  // Evidence for the course's concepts, their prerequisites elsewhere, and each check's concept.
  const courseDocIds = new Set(concepts.map((concept) => concept.id))
  const families = [...new Set([...checkCandidates, ...reviewCandidates].map((candidate) => candidate.item.familyId))]
  const answered = families.length > 0 ? await asLearner(db, learnerId, (tx) => readAnsweredFamilies(tx, learnerId, families)) : new Set<string>()
  const offers = capabilities.checks ? checkOffers(lessonIds, checkCandidates, index, answered) : new Map<string, CheckOffer>()
  const extraDocIds = [
    ...edges.flatMap((edge) => (edge.prerequisite && !courseDocIds.has(edge.prerequisite) ? [edge.prerequisite] : [])),
    ...[...offers.values()].flatMap((offer) => (offer.conceptDocId && !courseDocIds.has(offer.conceptDocId) ? [offer.conceptDocId] : [])),
  ]
  const evidenceConcepts = [
    ...concepts,
    ...[...new Set(extraDocIds)].flatMap((id) => {
      const node = index.get(id)
      return node ? [{id, conceptId: node.conceptId}] : []
    }),
  ]
  const evidenceIds = [...new Set(evidenceConcepts.flatMap((concept) => evidenceIdsFor(concept, index)))]
  const stored = await readMapEvidence(db, learnerId, evidenceIds)
  const evidence = resolveEvidence(stored.mastery, stored.latestIndependent, index)

  if (capabilities.practice && learner.active.length === 0 && mistakes.length > 0) {
    const plan = planSession(mistakes, reviewCandidates, index, answered)
    if (plan.status === 'planned') {
      const seen = new Set<string>()
      const entries = plan.items.flatMap(({mistake}) => {
        if (seen.has(mistake.conceptDocId)) return []
        seen.add(mistake.conceptDocId)
        return [{conceptDocId: mistake.conceptDocId, conceptId: mistake.conceptId, reason: mistake.reason}]
      })
      practice = {status: 'session', resumed: false, concepts: entries}
    }
  }

  const {items, notices} = buildPlan({
    course: {id: course._id, title: course.title, slug: course.slug, lessons},
    progress,
    concepts,
    edges,
    evidence,
    index,
    practice,
    checks: capabilities.checks ? {status: 'ready', byLesson: offers} : {status: 'unavailable'},
    now,
  })
  const completed = new Set(progress.filter((row) => row.completed).map((row) => row.lessonId))
  return ok({
    status: 'ready',
    goal: learner.goal ? goalBody(learner.goal) : null,
    course: {
      id: course._id,
      title: course.title,
      slug: course.slug,
      totalLessons: lessons.length,
      completedLessons: lessons.filter((lesson) => completed.has(lesson._id)).length,
    },
    items,
    notices,
    policyVersion: NEXT_ACTION_POLICY_VERSION,
  })
}
