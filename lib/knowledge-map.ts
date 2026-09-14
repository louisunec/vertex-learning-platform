import {conceptDocumentId} from './concepts/cluster.ts'
import {findCycles, validateGraph, type GraphEdge} from './concepts/graph.ts'
import {resolveConcept, type ConceptNode} from './concepts/resolve.ts'
import {EMPTY_COUNTS, type EvidenceKind, type EvidenceReason, type MasteryCounts} from './learner/evidence.ts'

/**
 * View model for the My Learning knowledge map. Pure and deterministic: the
 * nodes and edges are the published, reviewed concept graph for one course;
 * each node's state is derived from the learner's own stored evidence under
 * the conservative PR-4 policy. The uncalibrated `estimate` is never used.
 */

export const MAP_STATES = ['not_assessed', 'developing', 'needs_practice', 'recent_evidence'] as const
export type MapState = (typeof MAP_STATES)[number]

/** A correct independent response newer than this is "recent evidence". */
export const RECENT_EVIDENCE_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000

export type LatestIndependent = {correct: boolean; createdAt: Date}

/**
 * The learner's state for one concept. Only counted evidence (independent or
 * assisted) moves a concept out of "not assessed"; the latest independent
 * response decides between "needs practice", "developing", and "recent
 * evidence"; assisted-only evidence can reach "developing" at most.
 */
export function mapState(counts: MasteryCounts, latestIndependent: LatestIndependent | null, now: Date): MapState {
  const independent = counts.independentCorrect + counts.independentIncorrect
  const assisted = counts.assistedCorrect + counts.assistedIncorrect
  if (independent > 0 && latestIndependent) {
    if (!latestIndependent.correct) return 'needs_practice'
    return now.getTime() - latestIndependent.createdAt.getTime() <= RECENT_EVIDENCE_DAYS * DAY_MS
      ? 'recent_evidence'
      : 'developing'
  }
  // Independent counts without a readable latest attempt: evidence exists, recency is unknown.
  if (independent > 0) return 'developing'
  if (assisted > 0) return counts.assistedCorrect > 0 ? 'developing' : 'needs_practice'
  return 'not_assessed'
}

export type MasteryRow = MasteryCounts & {conceptId: string}
export type LatestIndependentRow = LatestIndependent & {conceptId: string}

export type ConceptEvidenceSummary = {counts: MasteryCounts; latestIndependent: LatestIndependent | null}

/**
 * Evidence keyed by the concept document id it resolves to today. Rows are
 * stored under the stable concept id recorded at grading time; a concept
 * merged since then passes its evidence to its successor. A split concept
 * resolves to no single concept, so its evidence is left out (reconciliation
 * is a separate, conservative step) rather than copied.
 */
export function resolveEvidence(
  mastery: ReadonlyArray<MasteryRow>,
  latest: ReadonlyArray<LatestIndependentRow>,
  index: ReadonlyMap<string, ConceptNode>,
): Map<string, ConceptEvidenceSummary> {
  const byConcept = new Map<string, ConceptEvidenceSummary>()
  const entry = (conceptId: string) => {
    const resolved = resolveConcept(conceptDocumentId(conceptId), index)
    if (resolved.status !== 'active') return null
    let summary = byConcept.get(resolved.id)
    if (!summary) {
      summary = {counts: {...EMPTY_COUNTS}, latestIndependent: null}
      byConcept.set(resolved.id, summary)
    }
    return summary
  }
  for (const row of mastery) {
    const summary = entry(row.conceptId)
    if (!summary) continue
    summary.counts = {
      independentCorrect: summary.counts.independentCorrect + row.independentCorrect,
      independentIncorrect: summary.counts.independentIncorrect + row.independentIncorrect,
      assistedCorrect: summary.counts.assistedCorrect + row.assistedCorrect,
      assistedIncorrect: summary.counts.assistedIncorrect + row.assistedIncorrect,
    }
  }
  for (const row of latest) {
    const summary = entry(row.conceptId)
    if (!summary) continue
    if (!summary.latestIndependent || row.createdAt > summary.latestIndependent.createdAt) {
      summary.latestIndependent = {correct: row.correct, createdAt: row.createdAt}
    }
  }
  return byConcept
}

/** Stable concept ids whose stored evidence resolves to `concept`: its own id and those of concepts merged into it. */
export function evidenceIdsFor(concept: {id: string; conceptId: string}, index: ReadonlyMap<string, ConceptNode>): string[] {
  const ids = new Set([concept.conceptId])
  for (const node of index.values()) {
    const resolved = resolveConcept(node.id, index)
    if (resolved.status === 'active' && resolved.id === concept.id) ids.add(node.conceptId)
  }
  return [...ids].toSorted()
}

export function countedAttempts(counts: MasteryCounts): number {
  return counts.independentCorrect + counts.independentIncorrect + counts.assistedCorrect + counts.assistedIncorrect
}

/* ---------- Course order and sources ---------- */

type CourseLessons = {modules: ReadonlyArray<{lessons: ReadonlyArray<{_id: string; title: string; slug: string}> | null}> | null}

export type CourseLesson = {_id: string; title: string; slug: string; number: number}

/** The course's lessons in module order, numbered from 1 (numbers are derived from order, never stored). */
export function numberedLessons(course: CourseLessons): Map<string, CourseLesson> {
  const lessons = new Map<string, CourseLesson>()
  for (const courseModule of course.modules ?? []) {
    for (const lesson of courseModule.lessons ?? []) {
      if (!lessons.has(lesson._id)) lessons.set(lesson._id, {...lesson, number: lessons.size + 1})
    }
  }
  return lessons
}

export type ConceptSource = {lessonId: string; startSeconds: number}

export type RelatedSource = {lesson: CourseLesson; startSeconds: number; href: string}

/** The concept's earliest cited moment in this course: lesson order first, then time. */
export function firstSource(
  sources: ReadonlyArray<ConceptSource>,
  lessons: ReadonlyMap<string, CourseLesson>,
): RelatedSource | null {
  let best: RelatedSource | null = null
  for (const source of sources) {
    const lesson = lessons.get(source.lessonId)
    if (!lesson || !Number.isFinite(source.startSeconds) || source.startSeconds < 0) continue
    if (
      !best ||
      lesson.number < best.lesson.number ||
      (lesson.number === best.lesson.number && source.startSeconds < best.startSeconds)
    ) {
      best = {lesson, startSeconds: source.startSeconds, href: lessonMomentHref(lesson.slug, source.startSeconds)}
    }
  }
  return best
}

/** Deep link to a second of a lesson video (the lesson page's `?t=` wins over the resume position). */
export function lessonMomentHref(slug: string, startSeconds: number): string {
  return `/lessons/${slug}?t=${Math.max(0, Math.floor(startSeconds))}`
}

/* ---------- Graph ---------- */

export type MapConcept = {id: string; conceptId: string; name: string; sources: ReadonlyArray<ConceptSource>}

/**
 * Concepts in the order the course teaches them: by their earliest source,
 * then by name. Concepts with no source in this course go last.
 */
export function orderConcepts<C extends MapConcept>(concepts: ReadonlyArray<C>, lessons: ReadonlyMap<string, CourseLesson>): C[] {
  const keyed = concepts.map((concept) => ({concept, first: firstSource(concept.sources, lessons)}))
  return keyed
    .toSorted((a, b) => {
      if (a.first && b.first) {
        const byLesson = a.first.lesson.number - b.first.lesson.number
        if (byLesson !== 0) return byLesson
        const byTime = a.first.startSeconds - b.first.startSeconds
        if (byTime !== 0) return byTime
      } else if (a.first || b.first) {
        return a.first ? -1 : 1
      }
      return a.concept.name.localeCompare(b.concept.name) || (a.concept.id < b.concept.id ? -1 : 1)
    })
    .map((entry) => entry.concept)
}

export type MapEdge = {id: string; from: string; to: string}

/**
 * The prerequisite edges safe to draw: only published, approved edges that
 * pass the PR-3 integrity checks against the concepts on the map. An edge
 * named in any defect (self-edge, duplicate, dangling or inactive endpoint,
 * cycle) is dropped, never drawn as a prerequisite.
 */
export function drawableEdges(concepts: ReadonlyArray<MapConcept>, edges: ReadonlyArray<GraphEdge>): {edges: MapEdge[]; dropped: string[]} {
  const {defects} = validateGraph({
    concepts: concepts.map((concept) => ({id: concept.id, conceptId: concept.conceptId, reviewStatus: 'approved', accessible: true})),
    edges,
  })
  const dropped = new Set(defects.flatMap((defect) => defect.edgeIds))
  const drawn = edges
    .filter((edge) => edge.status === 'approved' && !dropped.has(edge.id) && edge.prerequisite && edge.dependent)
    .map((edge) => ({id: edge.id, from: edge.prerequisite!, to: edge.dependent!}))
  return {edges: drawn, dropped: [...dropped].toSorted()}
}

/** An AI-proposed edge: a generator draft with status `proposed` that no editor has reviewed. */
export type ProposedEdgeRow = {id: string; prerequisite: string | null; dependent: string | null}

/**
 * AI-proposed edges safe to show beside the approved graph — display only,
 * never part of it. Dropped: endpoints not on the map, self-links, a pair the
 * approved graph already relates (either direction), repeats of a pair (the
 * first by id is kept), and every proposal inside a cycle formed with the
 * approved edges and the other proposals.
 */
export function displayableProposedEdges(
  concepts: ReadonlyArray<MapConcept>,
  approved: ReadonlyArray<MapEdge>,
  proposed: ReadonlyArray<ProposedEdgeRow>,
): {edges: MapEdge[]; dropped: string[]} {
  const onMap = new Set(concepts.map((concept) => concept.id))
  const related = new Set(approved.flatMap((edge) => [`${edge.from}→${edge.to}`, `${edge.to}→${edge.from}`]))
  const dropped: string[] = []
  const kept: MapEdge[] = []
  for (const row of proposed.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const {prerequisite: from, dependent: to} = row
    const valid = from && to && onMap.has(from) && onMap.has(to) && from !== to
    if (!valid || related.has(`${from}→${to}`) || kept.some((edge) => edge.from === from && edge.to === to)) {
      dropped.push(row.id)
      continue
    }
    kept.push({id: row.id, from, to})
  }
  const cycles = findCycles([...approved, ...kept]).map((members) => new Set(members))
  const edges = kept.filter((edge) => {
    const inCycle = cycles.some((members) => members.has(edge.from) && members.has(edge.to))
    if (inCycle) dropped.push(edge.id)
    return !inCycle
  })
  return {edges, dropped: dropped.toSorted()}
}

/**
 * Whether this learner may see AI-proposed edges: a display-only option for
 * the Clerk user ids listed (comma-separated) in the server-only
 * `KNOWLEDGE_MAP_PROPOSED_EDGES_USER_IDS`. Off when unset.
 */
export function canViewProposedEdges(userId: string, allowlist: string | undefined): boolean {
  return (allowlist ?? '')
    .split(',')
    .map((id) => id.trim())
    .some((id) => id !== '' && id === userId)
}

/** A cited moment of an edge's evidence. */
export type EdgeEvidence = {lessonId: string | null; startSeconds: number | null}

/**
 * The edge's cited moments in this course, as lesson deep links in teaching
 * order, one per lesson second. Moments in lessons outside the course are
 * left out.
 */
export function edgeSources(evidence: ReadonlyArray<EdgeEvidence>, lessons: ReadonlyMap<string, CourseLesson>): RelatedSource[] {
  const sources = new Map<string, RelatedSource>()
  for (const {lessonId, startSeconds} of evidence) {
    const lesson = lessonId ? lessons.get(lessonId) : undefined
    if (!lesson || typeof startSeconds !== 'number' || !Number.isFinite(startSeconds) || startSeconds < 0) continue
    const second = Math.floor(startSeconds)
    const key = `${lesson._id}@${second}`
    if (!sources.has(key)) sources.set(key, {lesson, startSeconds: second, href: lessonMomentHref(lesson.slug, second)})
  }
  return [...sources.values()].toSorted((a, b) => a.lesson.number - b.lesson.number || a.startSeconds - b.startSeconds)
}

/* ---------- Layout ---------- */

/** Sized so three columns fit the map card at desktop width (658px of 662px). */
export const MAP_LAYOUT = {
  columns: 3,
  nodeWidth: 190,
  nodeHeight: 54,
  columnGap: 28,
  rowGap: 142,
  paddingX: 16,
  paddingY: 60,
} as const

export type PlacedNode = {id: string; x: number; y: number; row: number; column: number}
export type PlacedEdge<E extends MapEdge = MapEdge> = E & {path: string}

/**
 * Grid layout in teaching order, `MAP_LAYOUT.columns` per row. Edges between
 * neighbours in a row are straight; others curve from the bottom of the
 * earlier row to the top of the later one, or arc over the row. Extra edge
 * fields are carried through.
 */
export function layoutMap<E extends MapEdge>(orderedIds: ReadonlyArray<string>, edges: ReadonlyArray<E>) {
  const {columns, nodeWidth: w, nodeHeight: h, columnGap, rowGap, paddingX, paddingY} = MAP_LAYOUT
  const nodes = new Map<string, PlacedNode>()
  orderedIds.forEach((id, i) => {
    const row = Math.floor(i / columns)
    const column = i % columns
    nodes.set(id, {id, row, column, x: paddingX + column * (w + columnGap), y: paddingY + row * (h + rowGap)})
  })
  const rows = Math.ceil(orderedIds.length / columns)
  const width = paddingX * 2 + columns * w + (columns - 1) * columnGap
  const height = rows === 0 ? 0 : paddingY * 2 + rows * h + (rows - 1) * rowGap

  const placedEdges: PlacedEdge<E>[] = []
  for (const edge of edges) {
    const a = nodes.get(edge.from)
    const b = nodes.get(edge.to)
    if (!a || !b) continue
    placedEdges.push({...edge, path: edgePath(a, b)})
  }
  return {width, height, nodes: orderedIds.map((id) => nodes.get(id)!), edges: placedEdges}
}

/** Leaves room for the arrowhead so it stops at the target's border. */
const ARROW_GAP = 6

function edgePath(a: PlacedNode, b: PlacedNode): string {
  const {nodeWidth: w, nodeHeight: h} = MAP_LAYOUT
  const r = (value: number) => Math.round(value * 10) / 10
  if (a.row === b.row && Math.abs(a.column - b.column) === 1) {
    const forward = b.column > a.column
    const x1 = forward ? a.x + w : a.x
    const x2 = forward ? b.x - ARROW_GAP : b.x + w + ARROW_GAP
    return `M ${r(x1)} ${r(a.y + h / 2)} L ${r(x2)} ${r(b.y + h / 2)}`
  }
  if (a.row === b.row) {
    const lift = 44
    const x1 = a.x + w / 2
    const x2 = b.x + w / 2
    return `M ${r(x1)} ${r(a.y)} C ${r(x1)} ${r(a.y - lift)} ${r(x2)} ${r(b.y - lift)} ${r(x2)} ${r(b.y - ARROW_GAP)}`
  }
  const down = b.row > a.row
  const x1 = a.x + w * 0.8
  const y1 = down ? a.y + h : a.y
  const x2 = b.x + w / 2
  const y2 = down ? b.y - ARROW_GAP : b.y + h + ARROW_GAP
  const bend = (y2 - y1) / 2
  return `M ${r(x1)} ${r(y1)} C ${r(x1)} ${r(y1 + bend)} ${r(x2)} ${r(y2 - bend)} ${r(x2)} ${r(y2)}`
}

/* ---------- Selection and attempts ---------- */

/** The requested concept when it is on the map; otherwise the first to practise, otherwise the first. */
export function pickSelected<N extends {conceptId: string; state: MapState}>(nodes: ReadonlyArray<N>, requested: string | null): N | null {
  return (
    (requested ? nodes.find((node) => node.conceptId === requested) : undefined) ??
    nodes.find((node) => node.state === 'needs_practice') ??
    nodes[0] ??
    null
  )
}

export const ATTEMPT_LABELS: Record<EvidenceReason, string> = {
  first_independent_response: 'Independent attempt',
  hint_used: 'With a hint',
  answer_exposed: 'Solution shown',
  repeat_task: 'Repeat attempt',
}

export const ATTEMPT_BADGES: Record<EvidenceKind, string | null> = {
  independent: null,
  assisted: 'Assisted',
  not_counted: 'Not counted',
}

export type AttemptFeedbackItem = {
  id: string
  version: number
  correctReason: string | null
  distractorReasons: ReadonlyArray<{optionId: string; reason: string}> | null
}

/**
 * The reviewed reason for the option the learner chose, from the exact
 * assessment version they answered; `null` when that version is no longer
 * servable or has no reason for the option. Only this one string leaves the
 * answer key.
 */
export function attemptReason(
  attempt: {assessmentId: string; assessmentVersion: number; selectedOptionId: string; correct: boolean},
  items: ReadonlyMap<string, AttemptFeedbackItem>,
): string | null {
  const item = items.get(attempt.assessmentId)
  if (!item || item.version !== attempt.assessmentVersion) return null
  const reason = attempt.correct
    ? item.correctReason
    : item.distractorReasons?.find((entry) => entry.optionId === attempt.selectedOptionId)?.reason
  return reason?.trim() || null
}

/** "Based on 2 attempts; more practice needed." */
export function evidenceSummary(counted: number, state: MapState): string | null {
  if (counted === 0) return null
  const base = `Based on ${counted} ${counted === 1 ? 'attempt' : 'attempts'}`
  return state === 'needs_practice' ? `${base}; more practice needed.` : `${base}.`
}
