/**
 * Resolution of stored concept references through merges and splits
 * (development plan §5 PR-3). Old ids are never deleted: a merged concept
 * stays published as a tombstone pointing at its successor, so an assessment
 * or evidence record that cites it keeps its history and still resolves.
 *
 * A split never resolves to a single concept. Learner projections (PR-4)
 * must reconcile it conservatively instead of copying mastery to every new
 * concept, so the resolution says so explicitly.
 */

export const MAX_MERGE_HOPS = 8

/** A concept document as resolution reads it; ids are document ids (`concept-<conceptId>`). */
export type ConceptNode = {
  id: string
  conceptId: string
  reviewStatus: string
  mergedInto?: string | null
  splitInto?: ReadonlyArray<string> | null
}

export type ConceptResolution =
  | {status: 'active'; id: string; conceptId: string; path: string[]}
  | {status: 'split'; id: string; into: string[]; path: string[]; requiresReconciliation: true}
  | {
      status: 'unavailable'
      reason: 'missing' | 'not_approved' | 'rejected' | 'archived' | 'merge_cycle' | 'merge_too_deep' | 'invalid_merge_target'
      path: string[]
    }

/** Follows `mergedInto` from `id` to the active concept, a split, or the reason neither exists. */
export function resolveConcept(id: string, index: ReadonlyMap<string, ConceptNode>): ConceptResolution {
  const path: string[] = []
  let current = id
  for (let hop = 0; hop <= MAX_MERGE_HOPS; hop++) {
    if (path.includes(current)) return {status: 'unavailable', reason: 'merge_cycle', path: [...path, current]}
    path.push(current)
    const node = index.get(current)
    if (!node) return {status: 'unavailable', reason: 'missing', path}
    switch (node.reviewStatus) {
      case 'approved':
        return {status: 'active', id: node.id, conceptId: node.conceptId, path}
      case 'split': {
        const into = [...new Set(node.splitInto ?? [])]
        if (into.length < 2 || into.includes(node.id)) return {status: 'unavailable', reason: 'invalid_merge_target', path}
        return {status: 'split', id: node.id, into, path, requiresReconciliation: true}
      }
      case 'merged':
        if (!node.mergedInto) return {status: 'unavailable', reason: 'invalid_merge_target', path}
        current = node.mergedInto
        continue
      case 'rejected':
        return {status: 'unavailable', reason: 'rejected', path}
      case 'archived':
        return {status: 'unavailable', reason: 'archived', path}
      default:
        return {status: 'unavailable', reason: 'not_approved', path}
    }
  }
  return {status: 'unavailable', reason: 'merge_too_deep', path}
}
