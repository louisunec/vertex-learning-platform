import {type GraphEdge} from './concepts/graph.ts'
import {resolveConcept, type ConceptNode} from './concepts/resolve.ts'
import type {ProgressRow} from './course-progress.ts'
import {formatClock, formatRelativeTime, pluralize} from './format.ts'
import {
  drawableEdges,
  firstSource,
  lessonMomentHref,
  mapState,
  orderConcepts,
  RECENT_EVIDENCE_DAYS,
  type ConceptEvidenceSummary,
  type CourseLesson,
  type MapState,
} from './knowledge-map.ts'
import type {ReviewReason} from './learner/contracts.ts'
import {EMPTY_COUNTS} from './learner/evidence.ts'

/**
 * The next-action planner (development plan §5 PR-11). Pure and
 * deterministic: every item is generated from the learner's stored evidence
 * and progress, the published concept graph, and the delivery routes that
 * can serve it right now. There is no model call: ranking is the tier table
 * below, then course order.
 *
 * Evidence is read with the knowledge map's rule (`mapState`), never the
 * uncalibrated estimate. A prerequisite counts as demonstrated only when
 * the learner's latest independent response on it was correct; assisted
 * and unknown evidence never satisfy it. That evidence is kept however old
 * it is, but, as on the knowledge map, only a response within
 * `RECENT_EVIDENCE_DAYS` is recent evidence: an older one is described by its
 * age and ranks after recent confirmation, never as failure. Missing
 * evidence is described as missing, never as weakness or mastery, and a
 * course-order fallback is never called personalised.
 */

export const NEXT_ACTION_POLICY_VERSION = 'next-action-v1'

/** A plan holds at most this many items. */
export const PLAN_LIMIT = 5

/** Lesson checks offered in one plan. */
export const MAX_CHECK_ITEMS = 2

/** Kinds with a smaller share of the plan: a couple of checks, and one course-order fallback. */
const KIND_LIMITS: Partial<Record<ActionKind, number>> = {diagnose: MAX_CHECK_ITEMS, next_lesson: 1}

/** Cited chunks this close together form one source span. */
export const SPAN_GAP_SECONDS = 2

export const ACTION_KINDS = ['practise', 'continue', 'learn', 'diagnose', 'next_lesson'] as const
export type ActionKind = (typeof ACTION_KINDS)[number]

export const REASON_CODES = [
  'recent_mistake_review',
  'resume_started_lesson',
  'prerequisites_demonstrated',
  'prerequisites_demonstrated_earlier',
  'weak_evidence_revisit',
  'no_evidence_check',
  'no_prerequisites_recorded',
  'prerequisites_unverified',
  'course_order',
] as const
export type ReasonCode = (typeof REASON_CODES)[number]

/**
 * Ranking: lower tiers first; within a tier, course order. Readiness shown
 * by older evidence ranks after recent confirmation. Items without verified
 * readiness share the last tier with the plain course-order lesson, so that
 * part of a plan really is in course order.
 */
export const TIERS: Record<ReasonCode, number> = {
  recent_mistake_review: 1,
  resume_started_lesson: 2,
  prerequisites_demonstrated: 3,
  prerequisites_demonstrated_earlier: 4,
  weak_evidence_revisit: 5,
  no_evidence_check: 6,
  no_prerequisites_recorded: 7,
  prerequisites_unverified: 7,
  course_order: 7,
}

const KIND_OF: Record<ReasonCode, ActionKind> = {
  recent_mistake_review: 'practise',
  resume_started_lesson: 'continue',
  prerequisites_demonstrated: 'learn',
  prerequisites_demonstrated_earlier: 'learn',
  weak_evidence_revisit: 'learn',
  no_evidence_check: 'diagnose',
  no_prerequisites_recorded: 'learn',
  prerequisites_unverified: 'learn',
  course_order: 'next_lesson',
}

/** Items that act on the learner's evidence about concepts, rather than on progress or course order. */
const CONCEPT_KINDS: ReadonlySet<ActionKind> = new Set(['practise', 'learn', 'diagnose'])

/** Items that open a lesson to watch; a plan has at most one per lesson. */
const WATCH_KINDS: ReadonlySet<ActionKind> = new Set(['continue', 'learn', 'next_lesson'])

export const NOTICE_CODES = [
  'no_reviewed_concepts',
  'no_prerequisite_edges',
  'prerequisite_graph_defects',
  'no_evidence_no_check',
  'no_eligible_concept',
  'course_complete',
] as const
export type NoticeCode = (typeof NOTICE_CODES)[number]

export const READINESS = ['met', 'unmet', 'none_recorded', 'unverified'] as const
export type Readiness = (typeof READINESS)[number]

export const DELIVERIES = ['lesson_page', 'lesson_check', 'focused_review'] as const
export type Delivery = (typeof DELIVERIES)[number]

/* ---------- Input ---------- */

export type PlanLesson = CourseLesson & {durationSeconds: number | null}

export type PlanCourse = {id: string; title: string; slug: string; lessons: ReadonlyArray<PlanLesson>}

export type PlanSource = {chunkId: string | null; lessonId: string; startSeconds: number; endSeconds: number | null}

export type PlanConcept = {id: string; conceptId: string; name: string; sources: ReadonlyArray<PlanSource>}

/**
 * What focused review would serve now: the learner's unfinished session, or
 * the one `planSession` would build, as concept document ids in session order.
 */
export type PracticeInput =
  | {status: 'unavailable'}
  | {status: 'none'}
  | {status: 'session'; resumed: boolean; concepts: ReadonlyArray<{conceptDocId: string; conceptId: string; reason: ReviewReason}>}

/** For each lesson whose check would issue a question now: the concept that question is on (null without one), and its progress. */
export type CheckOffer = {conceptDocId: string | null; remaining: number; total: number}

export type ChecksInput = {status: 'unavailable'} | {status: 'ready'; byLesson: ReadonlyMap<string, CheckOffer>}

export type PlanInput = {
  course: PlanCourse
  progress: ReadonlyArray<ProgressRow>
  concepts: ReadonlyArray<PlanConcept>
  /** Published, approved, current edges whose dependent is a course concept. */
  edges: ReadonlyArray<GraphEdge>
  /** Evidence by active concept document id (`resolveEvidence`), external prerequisites included. */
  evidence: ReadonlyMap<string, ConceptEvidenceSummary>
  /** Published concept nodes, to check prerequisites taught outside the course. */
  index: ReadonlyMap<string, ConceptNode>
  practice: PracticeInput
  checks: ChecksInput
  now: Date
}

/* ---------- Output ---------- */

export type EvidenceTrace = {
  conceptId: string
  state: MapState
  independentCorrect: number
  independentIncorrect: number
  assistedCorrect: number
  assistedIncorrect: number
  latestIndependent: {correct: boolean; at: string} | null
}

/** Why an item is in the plan, for inspection and tests. Never rendered. */
export type Provenance = {
  policyVersion: string
  delivery: Delivery
  evidence: EvidenceTrace[]
  readiness: Readiness | null
  /** Each prerequisite's knowledge-map state and the time of its latest independent response. */
  prerequisites: Array<{conceptId: string; demonstrated: boolean; inCourse: boolean; state: MapState; latestIndependentAt: string | null}>
  progress: {lessonId: string; resumeSeconds: number | null; updatedAt: string | null} | null
  sourceChunkIds: string[]
  check: {remaining: number; total: number} | null
  review: {resumed: boolean; conceptIds: string[]} | null
}

export type PlanSpan = {startSeconds: number; endSeconds: number | null}

export type PlanItem = {
  id: string
  kind: ActionKind
  reasonCode: ReasonCode
  tier: number
  title: string
  reason: string
  actionLabel: string
  href: string
  lesson: {id: string; title: string; slug: string; number: number; durationSeconds: number | null} | null
  concept: {conceptId: string; name: string} | null
  span: PlanSpan | null
  provenance: Provenance
}

export type Plan = {items: PlanItem[]; notices: NoticeCode[]}

/* ---------- Evidence and readiness ---------- */

const NO_EVIDENCE: ConceptEvidenceSummary = {counts: EMPTY_COUNTS, latestIndependent: null}

/** Latest independent response correct: the only evidence that satisfies a prerequisite. */
export function isDemonstrated(summary: ConceptEvidenceSummary | undefined): boolean {
  return summary?.latestIndependent?.correct === true && summary.counts.independentCorrect > 0
}

export type ReadinessResult = {readiness: Readiness; prerequisites: string[]}

/**
 * Prerequisite readiness for every course concept. Edges between course
 * concepts are validated with the PR-3 checks (`drawableEdges`); a concept
 * named by a failing edge is `unverified`. An edge from outside the course
 * counts only when its prerequisite is an active approved concept under its
 * own id; otherwise the dependent is `unverified` too.
 */
export function prerequisiteReadiness(
  concepts: ReadonlyArray<PlanConcept>,
  edges: ReadonlyArray<GraphEdge>,
  index: ReadonlyMap<string, ConceptNode>,
  evidence: ReadonlyMap<string, ConceptEvidenceSummary>,
): {byConcept: Map<string, ReadinessResult>; defects: boolean} {
  const inCourse = new Set(concepts.map((concept) => concept.id))
  const approved = edges.filter((edge) => edge.status === 'approved' && edge.dependent && inCourse.has(edge.dependent))
  const internal = approved.filter((edge) => edge.prerequisite && inCourse.has(edge.prerequisite))
  const external = approved.filter((edge) => !edge.prerequisite || !inCourse.has(edge.prerequisite))

  const {edges: drawn, dropped} = drawableEdges(concepts, internal)
  const unverified = new Set<string>()
  for (const edge of internal) {
    if (!dropped.includes(edge.id)) continue
    for (const id of [edge.prerequisite, edge.dependent]) if (id) unverified.add(id)
  }
  const prerequisites = new Map<string, Set<string>>()
  const add = (dependent: string, prerequisite: string) =>
    prerequisites.set(dependent, (prerequisites.get(dependent) ?? new Set()).add(prerequisite))
  for (const edge of drawn) add(edge.to, edge.from)
  let externalDefect = false
  for (const edge of external) {
    const resolved = edge.prerequisite ? resolveConcept(edge.prerequisite, index) : null
    if (resolved?.status === 'active' && resolved.id === edge.prerequisite) add(edge.dependent!, edge.prerequisite)
    else {
      externalDefect = true
      unverified.add(edge.dependent!)
    }
  }

  const byConcept = new Map<string, ReadinessResult>()
  for (const concept of concepts) {
    const ids = [...(prerequisites.get(concept.id) ?? [])].toSorted()
    let readiness: Readiness
    if (unverified.has(concept.id)) readiness = 'unverified'
    else if (ids.length === 0) readiness = 'none_recorded'
    else readiness = ids.every((id) => isDemonstrated(evidence.get(id))) ? 'met' : 'unmet'
    byConcept.set(concept.id, {readiness, prerequisites: ids})
  }
  return {byConcept, defects: dropped.length > 0 || externalDefect}
}

/* ---------- Source spans ---------- */

export type ConceptSpan = {lesson: PlanLesson; startSeconds: number; endSeconds: number | null; chunkIds: string[]}

/**
 * The concept's first coherent source span: its earliest cited moment in
 * course order, extended over the concept's own cited chunks in that lesson
 * while they are contiguous (within `SPAN_GAP_SECONDS`). Times come from
 * stored chunk records only and are bounded by the lesson's stored duration.
 */
export function conceptSpan(sources: ReadonlyArray<PlanSource>, lessons: ReadonlyMap<string, PlanLesson>): ConceptSpan | null {
  const valid = sources.filter((source) => {
    const lesson = lessons.get(source.lessonId)
    if (!lesson || !Number.isFinite(source.startSeconds) || source.startSeconds < 0) return false
    return lesson.durationSeconds === null || source.startSeconds < lesson.durationSeconds
  })
  const first = firstSource(valid, lessons)
  if (!first) return null
  const lesson = lessons.get(first.lesson._id)!
  const [head, ...rest] = valid
    .filter((source) => source.lessonId === lesson._id && source.startSeconds >= first.startSeconds)
    .toSorted((a, b) => a.startSeconds - b.startSeconds || (a.endSeconds ?? 0) - (b.endSeconds ?? 0))
  const endOf = (source: PlanSource) =>
    source.endSeconds !== null && source.endSeconds > source.startSeconds ? source.endSeconds : null
  let end = endOf(head)
  const chunkIds = head.chunkId ? [head.chunkId] : []
  for (const source of end === null ? [] : rest) {
    const sourceEnd = endOf(source)
    if (sourceEnd === null || source.startSeconds > end! + SPAN_GAP_SECONDS) break
    end = Math.max(end!, sourceEnd)
    if (source.chunkId) chunkIds.push(source.chunkId)
  }
  if (end !== null && lesson.durationSeconds !== null) end = Math.min(end, lesson.durationSeconds)
  return {lesson, startSeconds: Math.floor(first.startSeconds), endSeconds: end === null ? null : Math.floor(end), chunkIds}
}

/* ---------- Planning ---------- */

const PRACTISE_REASON: Record<ReviewReason, (name: string) => string> = {
  independent_incorrect: (name) => `Your last answer on ${name}, given on your own, was incorrect.`,
  assisted_incorrect: (name) => `Your last answer on ${name} used help and was incorrect.`,
  assisted_correct: (name) => `Your last correct answer on ${name} used help, so there’s no independent answer yet.`,
}

function names(list: ReadonlyArray<string>): string {
  if (list.length <= 2) return list.join(' and ')
  return `${list.slice(0, 2).join(', ')} and ${pluralize(list.length - 2, 'more')}`
}

/**
 * Why a concept is ready: its demonstrated prerequisites, and, for any whose
 * latest independent response is older than recent evidence, how old it is.
 */
function readinessReason(prerequisites: ReadonlyArray<{name: string; at: Date; recent: boolean}>, now: Date): string {
  const noun = prerequisites.length === 1 ? 'prerequisite' : 'prerequisites'
  const answered = `You answered its ${noun} ${names(prerequisites.map((entry) => entry.name))} correctly on your own`
  const older = prerequisites.filter((entry) => !entry.recent)
  if (older.length === 0) return `${answered} within the last ${RECENT_EVIDENCE_DAYS} days.`
  const oldest = formatRelativeTime(older.reduce((a, b) => (b.at < a.at ? b : a)).at, now)
  const age =
    older.length === 1
      ? `Your latest answer on ${older[0].name} was ${oldest}.`
      : `Your latest answers on ${names(older.map((entry) => entry.name))} are older than ${RECENT_EVIDENCE_DAYS} days, the oldest from ${oldest}.`
  return `${answered}. ${age} Answers older than ${RECENT_EVIDENCE_DAYS} days count as developing, not recent evidence.`
}

function watchLabel(verb: string, startSeconds: number): string {
  return startSeconds > 0 ? `${verb} from ${formatClock(startSeconds)}` : `${verb} lesson`
}

/** Course position for ordering within a tier: lesson number, then second. */
type Candidate = Omit<PlanItem, 'tier' | 'kind'> & {order: [number, number]}

/** Builds the plan for one goal course. Deterministic for the same input. */
export function buildPlan(input: PlanInput): Plan {
  const {course, now} = input
  const lessons = new Map(course.lessons.map((lesson) => [lesson._id, lesson]))
  const courseRows = input.progress.filter((row) => lessons.has(row.lessonId))
  const completed = new Set(courseRows.filter((row) => row.completed).map((row) => row.lessonId))
  const conceptsById = new Map(input.concepts.map((concept) => [concept.id, concept]))
  const summary = (id: string) => input.evidence.get(id) ?? NO_EVIDENCE
  const stateOf = (id: string) => mapState(summary(id).counts, summary(id).latestIndependent, now)
  const trace = (concept: PlanConcept): EvidenceTrace => {
    const {counts, latestIndependent} = summary(concept.id)
    return {
      conceptId: concept.conceptId,
      state: stateOf(concept.id),
      ...counts,
      latestIndependent: latestIndependent
        ? {correct: latestIndependent.correct, at: latestIndependent.createdAt.toISOString()}
        : null,
    }
  }
  const lessonRef = (lesson: PlanLesson) => ({
    id: lesson._id,
    title: lesson.title,
    slug: lesson.slug,
    number: lesson.number,
    durationSeconds: lesson.durationSeconds,
  })
  const provenance = (delivery: Delivery, extra: Partial<Provenance> = {}): Provenance => ({
    policyVersion: NEXT_ACTION_POLICY_VERSION,
    delivery,
    evidence: [],
    readiness: null,
    prerequisites: [],
    progress: null,
    sourceChunkIds: [],
    check: null,
    review: null,
    ...extra,
  })

  const {byConcept: readiness, defects} = prerequisiteReadiness(input.concepts, input.edges, input.index, input.evidence)
  const spans = new Map(input.concepts.map((concept) => [concept.id, conceptSpan(concept.sources, lessons)]))
  const ordered = orderConcepts(input.concepts, lessons)
  const orderOf = (lesson: PlanLesson | null, seconds: number): [number, number] => [lesson?.number ?? Number.MAX_SAFE_INTEGER, seconds]

  const candidates: Array<{item: Omit<Candidate, 'order'>; order: Candidate['order']}> = []
  const add = ({order, ...item}: Candidate) => {
    candidates.push({item, order})
  }

  // Practise: what focused review would serve now, when it covers a course concept.
  const covered = new Set<string>()
  if (input.practice.status === 'session') {
    const inCourse = input.practice.concepts.filter((entry) => conceptsById.has(entry.conceptDocId))
    const first = inCourse[0]
    if (first) {
      const concept = conceptsById.get(first.conceptDocId)!
      for (const entry of inCourse) covered.add(entry.conceptDocId)
      const span = spans.get(concept.id) ?? null
      const others = input.practice.concepts.length - 1
      add({
        id: 'practise:focused-review',
        reasonCode: 'recent_mistake_review',
        title: concept.name,
        reason:
          PRACTISE_REASON[first.reason](concept.name) +
          (others > 0 ? ` Focused review covers it and ${pluralize(others, 'other concept')}.` : ''),
        actionLabel: input.practice.resumed ? 'Resume focused review' : 'Start focused review',
        href: '/my-learning/reviews',
        lesson: span ? lessonRef(span.lesson) : null,
        concept: {conceptId: concept.conceptId, name: concept.name},
        span: null,
        provenance: provenance('focused_review', {
          evidence: inCourse.map((entry) => trace(conceptsById.get(entry.conceptDocId)!)),
          review: {resumed: input.practice.resumed, conceptIds: input.practice.concepts.map((entry) => entry.conceptId)},
        }),
        order: [0, 0],
      })
    }
  }

  // Continue: the most recently touched started lesson that isn't complete.
  const started = courseRows
    .filter((row) => !row.completed)
    .toSorted((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.lessonId.localeCompare(b.lessonId))[0]
  if (started) {
    const lesson = lessons.get(started.lessonId)!
    const raw = started.resumeSeconds ?? 0
    const resume =
      Number.isFinite(raw) && raw > 0 && (lesson.durationSeconds === null || raw < lesson.durationSeconds) ? Math.floor(raw) : null
    const when = started.updatedAt && !Number.isNaN(Date.parse(started.updatedAt)) ? ` ${formatRelativeTime(started.updatedAt, now)}` : ''
    add({
      id: `continue:${lesson._id}`,
      reasonCode: 'resume_started_lesson',
      title: lesson.title,
      reason: resume ? `You stopped at ${formatClock(resume)}${when}.` : `You started this lesson${when}.`,
      actionLabel: resume ? `Resume at ${formatClock(resume)}` : 'Continue lesson',
      href: resume ? lessonMomentHref(lesson.slug, resume) : `/lessons/${lesson.slug}`,
      lesson: lessonRef(lesson),
      concept: null,
      span: resume ? {startSeconds: resume, endSeconds: null} : null,
      provenance: provenance('lesson_page', {
        progress: {lessonId: lesson._id, resumeSeconds: started.resumeSeconds, updatedAt: started.updatedAt},
      }),
      order: orderOf(lesson, 0),
    })
  }

  // Concepts: learn the ready ones, revisit weak ones focused review can't serve.
  for (const concept of ordered) {
    const span = spans.get(concept.id)
    if (!span) continue
    const state = stateOf(concept.id)
    const {counts, latestIndependent} = summary(concept.id)
    const ready = readiness.get(concept.id)!
    const prerequisiteTrace = ready.prerequisites.map((id) => ({
      conceptId: conceptsById.get(id)?.conceptId ?? input.index.get(id)?.conceptId ?? id,
      demonstrated: isDemonstrated(input.evidence.get(id)),
      inCourse: conceptsById.has(id),
      state: stateOf(id),
      latestIndependentAt: summary(id).latestIndependent?.createdAt.toISOString() ?? null,
    }))
    const base = {
      title: concept.name,
      href: lessonMomentHref(span.lesson.slug, span.startSeconds),
      lesson: lessonRef(span.lesson),
      concept: {conceptId: concept.conceptId, name: concept.name},
      span: {startSeconds: span.startSeconds, endSeconds: span.endSeconds},
      order: orderOf(span.lesson, span.startSeconds),
    }
    const conceptProvenance = (extra: Partial<Provenance> = {}) =>
      provenance('lesson_page', {evidence: [trace(concept)], sourceChunkIds: span.chunkIds, ...extra})

    const assistedOnly = counts.independentCorrect + counts.independentIncorrect === 0
    const weak = state === 'needs_practice' || (state === 'developing' && assistedOnly)
    if (weak && !covered.has(concept.id)) {
      const evidenceText = latestIndependent
        ? `Your last answer on ${concept.name}, given on your own, was incorrect.`
        : counts.assistedCorrect > 0
          ? `Your correct answers on ${concept.name} used help, so there’s no independent answer yet.`
          : `You’ve answered ${concept.name} only with help, and not correctly yet.`
      const practiceText =
        input.practice.status === 'unavailable' ? '' : ' Focused review isn’t offering a question on it right now.'
      add({
        ...base,
        id: `learn:${concept.conceptId}`,
        reasonCode: 'weak_evidence_revisit',
        reason: `${evidenceText}${practiceText} Revisit where the lesson explains it.`,
        actionLabel: watchLabel('Revisit', span.startSeconds),
        provenance: conceptProvenance({readiness: ready.readiness, prerequisites: prerequisiteTrace}),
      })
      continue
    }

    if (state !== 'not_assessed' || completed.has(span.lesson._id) || ready.readiness === 'unmet') continue
    // Met means every prerequisite's latest independent response was correct; the map state says whether it's recent.
    const demonstrated = ready.prerequisites.map((id) => ({
      name: conceptsById.get(id)?.name ?? 'a concept from another course',
      at: summary(id).latestIndependent!.createdAt,
      recent: stateOf(id) === 'recent_evidence',
    }))
    const reasonCode: ReasonCode =
      ready.readiness === 'met'
        ? demonstrated.every((entry) => entry.recent)
          ? 'prerequisites_demonstrated'
          : 'prerequisites_demonstrated_earlier'
        : ready.readiness === 'none_recorded'
          ? 'no_prerequisites_recorded'
          : 'prerequisites_unverified'
    const reason =
      ready.readiness === 'met'
        ? readinessReason(demonstrated, now)
        : reasonCode === 'no_prerequisites_recorded'
          ? `You haven’t answered any questions on ${concept.name} yet. No prerequisites are recorded for it, so this follows course order.`
          : `You haven’t answered any questions on ${concept.name} yet. Its prerequisites couldn’t be verified, so this follows course order.`
    add({
      ...base,
      id: `learn:${concept.conceptId}`,
      reasonCode,
      reason,
      actionLabel: watchLabel('Watch', span.startSeconds),
      provenance: conceptProvenance({readiness: ready.readiness, prerequisites: prerequisiteTrace}),
    })
  }

  // Diagnose: a lesson check that would issue a question on a concept with no evidence yet.
  if (input.checks.status === 'ready') {
    for (const lesson of course.lessons) {
      const offer = input.checks.byLesson.get(lesson._id)
      if (!offer) continue
      const concept = offer.conceptDocId ? conceptsById.get(offer.conceptDocId) : undefined
      if (offer.conceptDocId && stateOf(offer.conceptDocId) !== 'not_assessed') continue
      const covers = `The check covers ${pluralize(offer.total, 'idea')}.`
      add({
        id: `diagnose:${lesson._id}`,
        reasonCode: 'no_evidence_check',
        title: `Check: ${lesson.title}`,
        reason: concept
          ? `You haven’t answered any questions on ${concept.name} yet. This lesson’s check starts with it. ${covers}`
          : `You haven’t answered this lesson’s check yet. ${covers}`,
        actionLabel: 'Take the check',
        href: `/lessons/${lesson.slug}`,
        lesson: lessonRef(lesson),
        concept: concept ? {conceptId: concept.conceptId, name: concept.name} : null,
        span: null,
        provenance: provenance('lesson_check', {
          evidence: concept ? [trace(concept)] : [],
          check: {remaining: offer.remaining, total: offer.total},
        }),
        order: orderOf(lesson, 0),
      })
    }
  }

  // Course order: an incomplete lesson not already in the plan, as a plain fallback (one at most).
  for (const lesson of course.lessons) {
    if (completed.has(lesson._id)) continue
    const unfinished = courseRows.some((row) => row.lessonId === lesson._id) ? ' You haven’t finished it yet.' : ''
    add({
      id: `next:${lesson._id}`,
      reasonCode: 'course_order',
      title: lesson.title,
      reason: `Lesson ${lesson.number} of ${course.lessons.length} in course order.${unfinished}`,
      actionLabel: 'Start lesson',
      href: `/lessons/${lesson.slug}`,
      lesson: lessonRef(lesson),
      concept: null,
      span: null,
      provenance: provenance('lesson_page'),
      // After any concept item in the same lesson, which says more.
      order: orderOf(lesson, Number.MAX_SAFE_INTEGER),
    })
  }

  const sorted = candidates.toSorted(
    (a, b) =>
      TIERS[a.item.reasonCode] - TIERS[b.item.reasonCode] ||
      a.order[0] - b.order[0] ||
      a.order[1] - b.order[1] ||
      a.item.title.localeCompare(b.item.title) ||
      a.item.id.localeCompare(b.item.id),
  )
  const items: PlanItem[] = []
  const watched = new Set<string>()
  const taken = new Map<ActionKind, number>()
  for (const {item: candidate} of sorted) {
    if (items.length >= PLAN_LIMIT) break
    const kind = KIND_OF[candidate.reasonCode]
    if ((taken.get(kind) ?? 0) >= (KIND_LIMITS[kind] ?? PLAN_LIMIT)) continue
    if (WATCH_KINDS.has(kind) && candidate.lesson) {
      if (watched.has(candidate.lesson.id)) continue
      watched.add(candidate.lesson.id)
    }
    taken.set(kind, (taken.get(kind) ?? 0) + 1)
    items.push({...candidate, kind, tier: TIERS[candidate.reasonCode]})
  }

  const notices: NoticeCode[] = []
  const hasConcepts = input.concepts.length > 0
  if (!hasConcepts) notices.push('no_reviewed_concepts')
  if (hasConcepts && !input.edges.some((edge) => edge.status === 'approved')) notices.push('no_prerequisite_edges')
  if (defects) notices.push('prerequisite_graph_defects')
  const anyEvidence = input.concepts.some((concept) => stateOf(concept.id) !== 'not_assessed')
  if (hasConcepts && !anyEvidence && !items.some((item) => item.kind === 'diagnose')) notices.push('no_evidence_no_check')
  if (hasConcepts && !items.some((item) => CONCEPT_KINDS.has(item.kind))) notices.push('no_eligible_concept')
  if (course.lessons.length > 0 && course.lessons.every((lesson) => completed.has(lesson._id))) notices.push('course_complete')

  return {items, notices}
}
