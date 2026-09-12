import {resolveConcept, type ConceptNode} from './resolve.ts'

/**
 * Integrity and coverage checks for the published prerequisite graph
 * (development plan §5 PR-3). Read-only; run by `npm run validate:concepts`.
 * Nothing consumes the graph in PR-3, so validating after publication is
 * enough here — a later consumer (PR-11) must read only a validated graph.
 */

/** A published concept; `accessible` = at least one source lesson is in a published course. */
export type GraphConcept = ConceptNode & {accessible: boolean}

/** A published edge; endpoints are concept document ids. */
export type GraphEdge = {
  id: string
  prerequisite: string | null
  dependent: string | null
  status: string
}

export type GraphDefectCode =
  | 'self_edge'
  | 'duplicate_pair'
  | 'dangling_endpoint'
  | 'inactive_endpoint'
  | 'inaccessible_endpoint'
  | 'cycle'

export type GraphDefect = {code: GraphDefectCode; edgeIds: string[]; detail: string}

/** Strongly connected components with more than one node, via Tarjan's algorithm; each sorted, in stable order. */
export function findCycles(edges: ReadonlyArray<{from: string; to: string}>): string[][] {
  const adjacency = new Map<string, string[]>()
  for (const {from, to} of edges) {
    adjacency.set(from, [...(adjacency.get(from) ?? []), to])
    if (!adjacency.has(to)) adjacency.set(to, [])
  }
  let counter = 0
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const components: string[][] = []

  const visit = (node: string): void => {
    index.set(node, counter)
    low.set(node, counter)
    counter++
    stack.push(node)
    onStack.add(node)
    for (const next of adjacency.get(node) ?? []) {
      if (!index.has(next)) {
        visit(next)
        low.set(node, Math.min(low.get(node)!, low.get(next)!))
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node)!, index.get(next)!))
      }
    }
    if (low.get(node) === index.get(node)) {
      const component: string[] = []
      let member: string
      do {
        member = stack.pop()!
        onStack.delete(member)
        component.push(member)
      } while (member !== node)
      if (component.length > 1) components.push(component.toSorted())
    }
  }
  for (const node of [...adjacency.keys()].toSorted()) if (!index.has(node)) visit(node)
  return components.toSorted((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}

/**
 * Defects of the active graph — published edges with status `approved`:
 * self-edges, duplicate pairs, endpoints that do not exist, endpoints that
 * are not approved (drafts, rejected concepts, and merge/split tombstones —
 * an edge must be re-pointed to the successor by review), endpoints with no
 * accessible lesson, and cycles.
 */
export function validateGraph(input: {concepts: ReadonlyArray<GraphConcept>; edges: ReadonlyArray<GraphEdge>}): {
  activeEdges: number
  defects: GraphDefect[]
} {
  const concepts = new Map(input.concepts.map((concept) => [concept.id, concept]))
  const active = input.edges.filter((edge) => edge.status === 'approved')
  const defects: GraphDefect[] = []

  const pairs = new Map<string, string[]>()
  const cycleEdges: Array<{from: string; to: string; id: string}> = []
  for (const edge of active) {
    const {prerequisite, dependent} = edge
    if (prerequisite && prerequisite === dependent) {
      defects.push({code: 'self_edge', edgeIds: [edge.id], detail: `${prerequisite} depends on itself`})
      continue
    }
    const endpoints = [prerequisite, dependent]
    const missing = endpoints.filter((id) => !id || !concepts.has(id))
    if (missing.length > 0) {
      defects.push({code: 'dangling_endpoint', edgeIds: [edge.id], detail: `missing ${missing.map((id) => id ?? '(empty)').join(', ')}`})
      continue
    }
    for (const id of endpoints as string[]) {
      const concept = concepts.get(id)!
      if (concept.reviewStatus !== 'approved') {
        defects.push({code: 'inactive_endpoint', edgeIds: [edge.id], detail: `${id} is ${concept.reviewStatus}`})
      } else if (!concept.accessible) {
        defects.push({code: 'inaccessible_endpoint', edgeIds: [edge.id], detail: `${id} has no lesson in a published course`})
      }
    }
    const pair = `${prerequisite}→${dependent}`
    pairs.set(pair, [...(pairs.get(pair) ?? []), edge.id])
    cycleEdges.push({from: prerequisite!, to: dependent!, id: edge.id})
  }
  for (const [pair, ids] of pairs) {
    if (ids.length > 1) defects.push({code: 'duplicate_pair', edgeIds: ids.toSorted(), detail: pair})
  }
  for (const cycle of findCycles(cycleEdges)) {
    const members = new Set(cycle)
    const ids = cycleEdges.filter((edge) => members.has(edge.from) && members.has(edge.to)).map((edge) => edge.id)
    defects.push({code: 'cycle', edgeIds: ids.toSorted(), detail: cycle.join(' ⇄ ')})
  }
  return {activeEdges: active.length, defects}
}

/** An approved, current, published assessment in scope. */
export type CoverageAssessment = {
  id: string
  primaryConcept: string | null
  sourceChunkIds: ReadonlyArray<string>
}

export type CoverageReport = {
  /** Approved in-scope concepts no approved assessment resolves to. */
  uncovered: string[]
  /** Assessments without a primary concept, with chunk-overlap suggestions (never applied). */
  unlinked: Array<{assessmentId: string; suggestions: string[]}>
  /** Links that resolve through a merge to a different concept. */
  viaMerge: Array<{assessmentId: string; from: string; to: string}>
  /** Links to split concepts: reconciliation required, nothing is inferred. */
  needsReconciliation: Array<{assessmentId: string; conceptId: string; into: string[]}>
  /** Links that resolve to nothing usable. */
  unresolved: Array<{assessmentId: string; conceptId: string; reason: string}>
}

export const MAX_LINK_SUGGESTIONS = 3

/**
 * Assessment coverage of the in-scope approved concepts. `concepts` must hold
 * every concept a link may pass through (merge targets outside the scope
 * included); `sourceChunkIds` lists each approved concept's cited chunks.
 */
export function assessmentCoverage(input: {
  scope: ReadonlyArray<string>
  concepts: ReadonlyArray<ConceptNode & {sourceChunkIds?: ReadonlyArray<string> | null}>
  assessments: ReadonlyArray<CoverageAssessment>
}): CoverageReport {
  const index = new Map(input.concepts.map((concept) => [concept.id, concept]))
  const report: CoverageReport = {uncovered: [], unlinked: [], viaMerge: [], needsReconciliation: [], unresolved: []}
  const covered = new Set<string>()
  const approved = input.concepts.filter((concept) => concept.reviewStatus === 'approved')

  for (const assessment of input.assessments) {
    if (!assessment.primaryConcept) {
      const chunks = new Set(assessment.sourceChunkIds)
      const suggestions = approved
        .map((concept) => ({id: concept.id, overlap: (concept.sourceChunkIds ?? []).filter((chunk) => chunks.has(chunk)).length}))
        .filter((entry) => entry.overlap > 0)
        .toSorted((a, b) => b.overlap - a.overlap || (a.id < b.id ? -1 : 1))
        .slice(0, MAX_LINK_SUGGESTIONS)
        .map((entry) => entry.id)
      report.unlinked.push({assessmentId: assessment.id, suggestions})
      continue
    }
    const resolution = resolveConcept(assessment.primaryConcept, index)
    if (resolution.status === 'active') {
      covered.add(resolution.id)
      if (resolution.id !== assessment.primaryConcept) {
        report.viaMerge.push({assessmentId: assessment.id, from: assessment.primaryConcept, to: resolution.id})
      }
    } else if (resolution.status === 'split') {
      report.needsReconciliation.push({assessmentId: assessment.id, conceptId: resolution.id, into: resolution.into})
    } else {
      report.unresolved.push({assessmentId: assessment.id, conceptId: assessment.primaryConcept, reason: resolution.reason})
    }
  }
  const scope = new Set(input.scope)
  report.uncovered = approved.filter((concept) => scope.has(concept.id) && !covered.has(concept.id)).map((concept) => concept.id).toSorted()
  return report
}
