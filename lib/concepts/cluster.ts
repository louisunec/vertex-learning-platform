import {z} from 'zod'

import {normalizeForComparison} from '../assessments/generate.ts'
import {formatClock} from '../format.ts'
import {hashParts} from '../evidence/chunks.ts'
import {
  CONCEPT_EXTRACTION_CONFIG_VERSION,
  CONCEPT_EXTRACTION_PROMPT_VERSION,
  CONCEPT_FIELD_LIMITS,
  conceptSourceRefSchema,
  filterAliases,
  matchKey,
  uniqueTexts,
  type ConceptCandidate,
  type ConceptSourceRef,
} from './extract.ts'

export {matchKey}

/**
 * Deterministic projection of a course's extraction records into concept
 * drafts (development plan §5 PR-3) — no model call. Candidates are grouped
 * by lexical match keys, editor-accepted merge proposals join groups by
 * stable candidate id, and each result is matched against existing concepts
 * and given a stable id. Lexical matching misses synonyms; the semantic
 * consolidation step (`consolidate.ts`) proposes merges for editors to
 * confirm.
 *
 * Write policy: drafts only. A published concept is never written (new
 * evidence for it is reported), an unpublished draft an editor changed is
 * left alone, and an unchanged draft is not rewritten. A rejected concept is
 * never touched: the same candidates at the same source and generation
 * versions are suppressed; anything else is reconsidered as a new concept.
 * Rejecting a merge proposal never loses a concept: members of a rejected
 * proposal that was already applied are restored under their own ids, and
 * two projections never write one concept id.
 */

export const MAX_CONCEPT_ALIASES = 8
export const MAX_CONCEPT_OBJECTIVES = 4
export const MAX_CONCEPT_SOURCE_REFS = 8
export const MAX_CONCEPT_ID_LENGTH = 48

const CONCEPT_ID = /^cpt-[a-z0-9]+(?:-[a-z0-9]+)*$/
const TERMINAL_STATUSES = new Set(['split', 'archived'])

function keysOf(names: ReadonlyArray<string>): Set<string> {
  return new Set(names.map(matchKey).filter(Boolean))
}

/** `cpt-<kebab name>`, ASCII only and at most `MAX_CONCEPT_ID_LENGTH` characters, cut at a word boundary where one exists. */
export function baseConceptId(name: string): string {
  const slug = normalizeForComparison(name)
    .normalize('NFKD')
    .replace(/[^a-z0-9 ]/g, '')
    .trim()
    .replace(/\s+/g, '-')
  const full = `cpt-${slug || hashParts([name]).slice(0, 8)}`
  if (full.length <= MAX_CONCEPT_ID_LENGTH) return full
  const boundary = full.slice(0, MAX_CONCEPT_ID_LENGTH + 1).lastIndexOf('-')
  return (boundary > 'cpt-'.length ? full.slice(0, boundary) : full.slice(0, MAX_CONCEPT_ID_LENGTH)).replace(/-+$/, '')
}

/** The base id, or the first `-2`, `-3`, … variant not already taken. */
export function assignConceptId(name: string, taken: ReadonlySet<string>): string {
  const base = baseConceptId(name)
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const suffix = `-${n}`
    const candidate = `${base.slice(0, MAX_CONCEPT_ID_LENGTH - suffix.length).replace(/-+$/, '')}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
}

export function conceptDocumentId(conceptId: string): string {
  return `concept-${conceptId}`
}

/** The content fields a concept's revision and `contentHash` cover. */
export type ConceptContent = {
  name: string
  aliases: ReadonlyArray<string>
  summary: string
  objectives: ReadonlyArray<{text: string}>
  sourceRefs: ReadonlyArray<{chunkId: string; chunkRevision: string; lesson?: {_ref: string} | null}>
  lessons: ReadonlyArray<{_ref: string}>
}

/** Hash of a concept's content: skips identical rewrites and detects editor changes. */
export function conceptContentHash(content: ConceptContent): string {
  return hashParts([
    content.name,
    content.aliases.join(''),
    content.summary,
    content.objectives.map((objective) => objective.text).join(''),
    content.sourceRefs.map((ref) => `${ref.chunkId}@${ref.chunkRevision}@${ref.lesson?._ref ?? ''}`).join(''),
    content.lessons.map((lesson) => lesson._ref).join(''),
  ]).slice(0, 32)
}

/**
 * Suppression key of a projected concept: its candidates' fingerprints, the
 * revisions of every chunk they cite, and the extraction prompt and config
 * versions. A rejected concept suppresses only a projection with the same key.
 */
export function conceptSuppressionKey(candidates: ReadonlyArray<ConceptCandidate>): string {
  return hashParts([
    'concept',
    [...new Set(candidates.map((candidate) => candidate.fingerprint))].toSorted().join(','),
    [...new Set(candidates.flatMap((candidate) => candidate.sourceRefs.map((ref) => `${ref.chunkId}@${ref.chunkRevision}`)))]
      .toSorted()
      .join(','),
    CONCEPT_EXTRACTION_PROMPT_VERSION,
    CONCEPT_EXTRACTION_CONFIG_VERSION,
  ]).slice(0, 32)
}

const key = z.string().min(1)
const reference = z.object({_type: z.literal('reference'), _ref: key})

/** Shape written by the generator — mirrors `studio/schemaTypes/documents/concept.ts`. */
export const conceptDraftSchema = z.object({
  _id: z.string().startsWith('drafts.concept-'),
  _type: z.literal('concept'),
  conceptId: z.string().regex(CONCEPT_ID).max(MAX_CONCEPT_ID_LENGTH),
  name: z.string().min(1).max(CONCEPT_FIELD_LIMITS.name),
  aliases: z.array(z.string().min(1).max(CONCEPT_FIELD_LIMITS.alias)).max(MAX_CONCEPT_ALIASES),
  summary: z.string().min(1).max(CONCEPT_FIELD_LIMITS.summary),
  objectives: z
    .array(z.object({_key: key, _type: z.literal('conceptObjective'), text: z.string().min(1).max(CONCEPT_FIELD_LIMITS.objective)}))
    .min(1)
    .max(MAX_CONCEPT_OBJECTIVES),
  sourceRefs: z.array(conceptSourceRefSchema).min(1).max(MAX_CONCEPT_SOURCE_REFS),
  lessons: z.array(reference.extend({_key: key})).min(1),
  sourceExcerpt: z.string().min(1),
  revision: z.literal(1),
  reviewStatus: z.literal('needs_review'),
  sourceStatus: z.literal('current'),
  generation: z.object({
    course: reference,
    model: key,
    promptVersion: key,
    configVersion: key,
    extractionKeys: z.array(key).min(1),
    candidateIds: z.array(z.string().startsWith('cand-')).min(1),
    role: z.enum(['primary', 'secondary']),
    suppressionKey: key,
    reconsiders: key.optional(),
    appliedMerges: z.array(key).optional(),
    contentHash: key,
    generatedAt: z.iso.datetime(),
  }),
})

export type ConceptDraft = z.infer<typeof conceptDraftSchema>

/** Candidates of one processed span, in course order. */
export type RecordedSpan = {
  lessonId: string
  /** Position of the lesson in the course. */
  lessonOrder: number
  spanIndex: number
  extractionKey: string
  candidates: ReadonlyArray<ConceptCandidate>
}

/** An existing concept document (draft or published) as the projection reads it. */
export type ExistingConcept = ConceptContent & {
  _id: string
  conceptId: string
  reviewStatus: string
  mergedInto?: string | null
  generationCourse?: string | null
  contentHash?: string | null
  suppressionKey?: string | null
  /** Merge proposals applied to this draft (`generation.appliedMerges`). */
  appliedMerges?: ReadonlyArray<string> | null
}

/** A merge proposal of equivalent concepts, by stable candidate ids (see `consolidate.ts`). */
export type AcceptedMerge = {
  proposalId: string
  canonicalCandidateIds: ReadonlyArray<string>
  /** Every member, the canonical one included. */
  members: ReadonlyArray<{conceptId: string; candidateIds: ReadonlyArray<string>}>
}

export function isDraftId(id: string): boolean {
  return /^(drafts|versions)\./.test(id)
}

/** Whether an editor changed a generator draft since it was written. */
export function editedSinceGeneration(doc: ExistingConcept): boolean {
  return !doc.contentHash || doc.contentHash !== conceptContentHash(doc)
}

export type ConceptPlan = {
  /** Drafts to create or replace in place. */
  drafts: ConceptDraft[]
  /** Concept ids whose draft already holds this content. */
  unchanged: string[]
  /** Concept ids left alone because an editor changed the draft. */
  editorModified: string[]
  /** Projections matching a published concept, which is never written. */
  evidenceForPublished: Array<{conceptId: string; names: string[]}>
  /** Projections matching a split or archived concept (terminal): not proposed. */
  matchesRetired: Array<{conceptId: string; reviewStatus: string; names: string[]}>
  /** Projections matching a rejected concept at the same source and generation versions: not proposed. */
  suppressedRejected: Array<{conceptId: string; names: string[]}>
  /** New concepts reconsidering a rejected one whose source or generation versions changed. */
  reconsidered: Array<{conceptId: string; reconsiders: string}>
  /** Projections matching more than one existing concept: nothing written. */
  conflicts: Array<{names: string[]; conceptIds: string[]}>
  merges: {
    applied: Array<{proposalId: string; conceptId: string; members: string[]}>
    /** Proposals whose candidates no longer exist (source or versions changed): ignored. */
    stale: string[]
    /** Proposals touching a published concept: apply by the manual tombstone merge. */
    needsManual: Array<{proposalId: string; conceptIds: string[]}>
    /** Proposals sharing a concept with an earlier applied one: skipped. */
    overlapping: string[]
    /** Non-canonical member drafts an editor changed: left in place. */
    leftEdited: string[]
    /** Members of an applied proposal that was later rejected, restored under their own concept ids. */
    restored: Array<{proposalId: string; conceptId: string}>
  }
  /** Unpublished, unedited non-canonical drafts of applied merges, deleted with the canonical draft. */
  mergeDeletes: string[]
  /** Unpublished, unedited drafts from this course the projection no longer reproduces (deleted only under `force`). */
  unreproduced: string[]
  /** Source refs beyond `MAX_CONCEPT_SOURCE_REFS`, summed over drafts. */
  droppedSourceRefs: number
  /** Lexical groups: clusters of more than one candidate. */
  lexicalGroups: number
  clusters: number
}

type Member = {candidate: ConceptCandidate; span: RecordedSpan; order: number}

/** Union–find over candidates sharing any match key (name or alias). */
function clusterCandidates(spans: ReadonlyArray<RecordedSpan>): Member[][] {
  const members: Member[] = []
  const ordered = spans.toSorted((a, b) => a.lessonOrder - b.lessonOrder || a.spanIndex - b.spanIndex)
  for (const span of ordered) for (const candidate of span.candidates) members.push({candidate, span, order: members.length})

  const parent = members.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const owner = new Map<string, number>()
  for (const member of members) {
    for (const k of keysOf([member.candidate.name, ...member.candidate.aliases])) {
      const other = owner.get(k)
      if (other === undefined) owner.set(k, member.order)
      else {
        const [a, b] = [find(other), find(member.order)]
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b)
      }
    }
  }
  const groups = new Map<number, Member[]>()
  for (const member of members) {
    const root = find(member.order)
    groups.set(root, [...(groups.get(root) ?? []), member])
  }
  return [...groups.values()].toSorted((a, b) => a[0].order - b[0].order)
}

/** The member with the most cited chunks; ties go to the earliest in course order. */
function representativeOf(cluster: ReadonlyArray<Member>): Member {
  return cluster.reduce((best, member) =>
    member.candidate.sourceRefs.length > best.candidate.sourceRefs.length ? member : best,
  )
}

/** One ref per lesson first (so every lesson is represented), then the rest in course order, up to the cap. */
function selectSourceRefs(members: ReadonlyArray<Member>): {refs: ConceptSourceRef[]; dropped: number} {
  const order = new Map(members.map((member) => [member.span.lessonId, member.span.lessonOrder]))
  const unique = new Map<string, ConceptSourceRef>()
  for (const member of members) for (const ref of member.candidate.sourceRefs) if (!unique.has(ref.chunkId)) unique.set(ref.chunkId, ref)
  const sorted = [...unique.values()].toSorted(
    (a, b) => (order.get(a.lesson._ref) ?? 0) - (order.get(b.lesson._ref) ?? 0) || a.startSeconds - b.startSeconds,
  )
  const kept = new Set<ConceptSourceRef>()
  const seenLessons = new Set<string>()
  for (const ref of sorted) {
    if (kept.size >= MAX_CONCEPT_SOURCE_REFS) break
    if (!seenLessons.has(ref.lesson._ref)) {
      seenLessons.add(ref.lesson._ref)
      kept.add(ref)
    }
  }
  for (const ref of sorted) {
    if (kept.size >= MAX_CONCEPT_SOURCE_REFS) break
    kept.add(ref)
  }
  return {refs: sorted.filter((ref) => kept.has(ref)), dropped: sorted.length - kept.size}
}

/**
 * Other names and aliases grouped by match key (so plural and punctuation
 * variants count once, under their first spelling), most frequent first,
 * then first seen; never a variant of the concept's own name. The alias rule
 * (`filterAliases`) is applied against the concept's name, so another
 * member's narrower name ("Content Security Policy script-src") or a
 * component identifier ("script-src") never becomes an alias.
 */
function aliasesOf(members: ReadonlyArray<Member>, name: string): string[] {
  const counts = new Map<string, {value: string; count: number; first: number}>()
  let position = 0
  for (const member of members) {
    for (const value of [member.candidate.name, ...member.candidate.aliases]) {
      const k = matchKey(value)
      const entry = counts.get(k)
      if (entry) entry.count++
      else if (k) counts.set(k, {value: value.trim(), count: 1, first: position})
      position++
    }
  }
  counts.delete(matchKey(name))
  const ranked = [...counts.values()].toSorted((a, b) => b.count - a.count || a.first - b.first).map((entry) => entry.value)
  return filterAliases(name, ranked).kept.slice(0, MAX_CONCEPT_ALIASES)
}

/** A projected concept: one lexical cluster (`index`), or several joined by an accepted merge (canonical cluster first). */
type Unit = {clusters: Member[][]; index: number; proposalId: string | null}

type Match =
  | {status: 'none'}
  | {status: 'existing'; conceptId: string}
  /** A member of a rejected, already-applied merge whose draft was deleted: recreated under its own id. */
  | {status: 'restore'; conceptId: string; proposalId: string}
  | {status: 'rejected'; conceptIds: string[]}
  | {status: 'conflict'; conceptIds: string[]}

/**
 * Projects recorded candidates into concept drafts. `chunkText` supplies the
 * current text of cited chunks for the reviewers' source excerpt;
 * `acceptedMerges` and `rejectedMerges` are proposals an editor accepted or
 * rejected in the Studio.
 */
export function planConcepts(input: {
  spans: ReadonlyArray<RecordedSpan>
  existing: ReadonlyArray<ExistingConcept>
  courseId: string
  model: string
  chunkText: ReadonlyMap<string, string>
  now: Date
  acceptedMerges?: ReadonlyArray<AcceptedMerge>
  /** Proposals not accepted (rejected, or set back to proposed): an already-applied one is undone. */
  rejectedMerges?: ReadonlyArray<AcceptedMerge>
}): ConceptPlan {
  const {spans, existing, courseId, model, chunkText, now, acceptedMerges = [], rejectedMerges = []} = input
  const plan: ConceptPlan = {
    drafts: [],
    unchanged: [],
    editorModified: [],
    evidenceForPublished: [],
    matchesRetired: [],
    suppressedRejected: [],
    reconsidered: [],
    conflicts: [],
    merges: {applied: [], stale: [], needsManual: [], overlapping: [], leftEdited: [], restored: []},
    mergeDeletes: [],
    unreproduced: [],
    droppedSourceRefs: 0,
    lexicalGroups: 0,
    clusters: 0,
  }

  const byConceptId = new Map<string, ExistingConcept[]>()
  for (const doc of existing) byConceptId.set(doc.conceptId, [...(byConceptId.get(doc.conceptId) ?? []), doc])
  const existingKeys = new Map<string, Set<string>>()
  for (const doc of existing) {
    const keys = existingKeys.get(doc.conceptId) ?? new Set<string>()
    for (const k of keysOf([doc.name, ...doc.aliases])) keys.add(k)
    existingKeys.set(doc.conceptId, keys)
  }
  const mergedTarget = new Map<string, string>()
  for (const doc of existing) {
    const target = doc.reviewStatus === 'merged' && doc.mergedInto ? existing.find((other) => other._id === doc.mergedInto) : undefined
    if (target) mergedTarget.set(doc.conceptId, target.conceptId)
  }
  const isRejected = (conceptId: string) => (byConceptId.get(conceptId) ?? []).every((doc) => doc.reviewStatus === 'rejected')
  const isPublished = (conceptId: string) => (byConceptId.get(conceptId) ?? []).some((doc) => !isDraftId(doc._id))

  const matchOf = (members: ReadonlyArray<Member>): Match => {
    const clusterKeys = keysOf(members.flatMap((member) => [member.candidate.name, ...member.candidate.aliases]))
    const matched = new Set<string>()
    for (const [conceptId, keys] of existingKeys) {
      if ([...clusterKeys].some((k) => keys.has(k))) matched.add(mergedTarget.get(conceptId) ?? conceptId)
    }
    const active = [...matched].filter((conceptId) => !isRejected(conceptId)).toSorted()
    if (active.length > 1) return {status: 'conflict', conceptIds: active}
    if (active.length === 1) return {status: 'existing', conceptId: active[0]}
    if (matched.size > 0) return {status: 'rejected', conceptIds: [...matched].toSorted()}
    return {status: 'none'}
  }

  const clusters = clusterCandidates(spans)
  plan.clusters = clusters.length
  plan.lexicalGroups = clusters.filter((cluster) => cluster.length > 1).length

  // Accepted merges join clusters by stable candidate id, canonical cluster first.
  const clusterOf = new Map<string, number>()
  clusters.forEach((cluster, index) => cluster.forEach((member) => clusterOf.set(member.candidate._key, index)))
  const consumed = new Set<number>()
  const units: Unit[] = []
  for (const merge of acceptedMerges.toSorted((a, b) => (a.proposalId < b.proposalId ? -1 : 1))) {
    const indicesOf = (candidateIds: ReadonlyArray<string>) =>
      [...new Set(candidateIds.flatMap((id) => (clusterOf.has(id) ? [clusterOf.get(id)!] : [])))].toSorted((a, b) => a - b)
    const canonical = indicesOf(merge.canonicalCandidateIds)
    const memberIndices = merge.members.map((member) => indicesOf(member.candidateIds))
    if (canonical.length === 0 || memberIndices.some((indices) => indices.length === 0)) {
      plan.merges.stale.push(merge.proposalId)
      continue
    }
    const all = [...new Set([...canonical, ...memberIndices.flat()])]
    if (all.some((index) => consumed.has(index))) {
      plan.merges.overlapping.push(merge.proposalId)
      continue
    }
    const matches = all.map((index) => matchOf(clusters[index]))
    const published = matches.flatMap((match) => (match.status === 'existing' && isPublished(match.conceptId) ? [match.conceptId] : []))
    if (published.length > 0 || matches.some((match) => match.status === 'conflict')) {
      plan.merges.needsManual.push({proposalId: merge.proposalId, conceptIds: [...new Set(published)].toSorted()})
      continue
    }
    for (const index of all) consumed.add(index)
    const ordered = [canonical[0], ...all.filter((index) => index !== canonical[0])]
    units.push({clusters: ordered.map((index) => clusters[index]), index: canonical[0], proposalId: merge.proposalId})
  }
  clusters.forEach((cluster, index) => {
    if (!consumed.has(index)) units.push({clusters: [cluster], index, proposalId: null})
  })
  units.sort((a, b) => a.clusters[0][0].order - b.clusters[0][0].order)

  // A rejected proposal that was already applied: its absorbed members' clusters now match the canonical
  // draft through the aliases the merge gave it, so each is restored under its own concept id instead.
  const restoreAs = new Map<number, {conceptId: string; proposalId: string}>()
  for (const merge of rejectedMerges) {
    const appliedTo = new Set(existing.filter((doc) => doc.appliedMerges?.includes(merge.proposalId)).map((doc) => doc.conceptId))
    if (appliedTo.size === 0) continue
    for (const member of merge.members) {
      if (appliedTo.has(member.conceptId)) continue
      for (const id of member.candidateIds) {
        const index = clusterOf.get(id)
        if (index !== undefined) restoreAs.set(index, {conceptId: member.conceptId, proposalId: merge.proposalId})
      }
    }
  }
  const unitMatch = (unit: Unit): Match => {
    const restore = unit.proposalId === null ? restoreAs.get(unit.index) : undefined
    if (restore && byConceptId.has(restore.conceptId)) return {status: 'existing', conceptId: restore.conceptId}
    if (restore) return {status: 'restore', ...restore}
    return matchOf(unit.clusters[0])
  }
  const matches = units.map(unitMatch)
  // Two projections resolving to one concept id would overwrite each other: neither is written.
  const claims = new Map<string, number>()
  for (const match of matches) {
    if (match.status === 'existing' || match.status === 'restore') claims.set(match.conceptId, (claims.get(match.conceptId) ?? 0) + 1)
  }

  const taken = new Set([...existing.map((doc) => doc.conceptId), ...[...restoreAs.values()].map((restore) => restore.conceptId)])
  const reproduced = new Set<string>()

  for (const [position, unit] of units.entries()) {
    const [canonicalCluster, ...others] = unit.clusters
    const members = unit.clusters.flat()
    const names = uniqueTexts(members.map((member) => member.candidate.name))
    const suppressionKey = conceptSuppressionKey(members.map((member) => member.candidate))
    const representative = representativeOf(canonicalCluster).candidate
    const match = matches[position]
    // Drafts of non-canonical merge members are accounted for here even if the unit is skipped below.
    const otherMatches = others.map(matchOf)
    for (const otherMatch of otherMatches) if (otherMatch.status === 'existing') reproduced.add(otherMatch.conceptId)

    let conceptId: string
    let reconsiders: string | undefined
    if (match.status === 'conflict') {
      plan.conflicts.push({names, conceptIds: match.conceptIds})
      continue
    }
    if ((match.status === 'existing' || match.status === 'restore') && (claims.get(match.conceptId) ?? 0) > 1) {
      reproduced.add(match.conceptId)
      plan.conflicts.push({names, conceptIds: [match.conceptId]})
      continue
    }
    if (match.status === 'restore') {
      conceptId = match.conceptId
      reproduced.add(conceptId)
      plan.merges.restored.push({proposalId: match.proposalId, conceptId})
    } else if (match.status === 'existing') {
      conceptId = match.conceptId
      reproduced.add(conceptId)
      const docs = byConceptId.get(conceptId) ?? []
      const retired = docs.find((doc) => TERMINAL_STATUSES.has(doc.reviewStatus))
      if (retired) {
        plan.matchesRetired.push({conceptId, reviewStatus: retired.reviewStatus, names})
        continue
      }
      if (docs.some((doc) => !isDraftId(doc._id))) {
        plan.evidenceForPublished.push({conceptId, names})
        continue
      }
      if (docs.some(editedSinceGeneration)) {
        plan.editorModified.push(conceptId)
        continue
      }
    } else if (match.status === 'rejected') {
      const suppressedBy = match.conceptIds.find((id) => (byConceptId.get(id) ?? []).some((doc) => doc.suppressionKey === suppressionKey))
      if (suppressedBy) {
        plan.suppressedRejected.push({conceptId: suppressedBy, names})
        continue
      }
      reconsiders = match.conceptIds[0]
      conceptId = assignConceptId(representative.name, taken)
      taken.add(conceptId)
      reproduced.add(conceptId)
      plan.reconsidered.push({conceptId, reconsiders})
    } else {
      conceptId = assignConceptId(representative.name, taken)
      taken.add(conceptId)
      reproduced.add(conceptId)
    }

    // Non-canonical members of an applied merge: their own unedited drafts go with this write.
    const absorbed: string[] = []
    for (const otherMatch of otherMatches) {
      if (otherMatch.status !== 'existing' || otherMatch.conceptId === conceptId) continue
      absorbed.push(otherMatch.conceptId)
      for (const doc of byConceptId.get(otherMatch.conceptId) ?? []) {
        if (!isDraftId(doc._id)) continue
        if (editedSinceGeneration(doc)) plan.merges.leftEdited.push(doc._id)
        else if (doc.generationCourse === courseId) plan.mergeDeletes.push(doc._id)
      }
    }

    const {refs, dropped} = selectSourceRefs(members)
    plan.droppedSourceRefs += dropped
    const lessons = [...new Set(refs.map((ref) => ref.lesson._ref))]
    const objectives = uniqueTexts([...representative.objectives, ...members.flatMap((member) => member.candidate.objectives)])
      .slice(0, MAX_CONCEPT_OBJECTIVES)
      .map((text) => ({
        _key: `obj-${hashParts([conceptId, normalizeForComparison(text)]).slice(0, 10)}`,
        _type: 'conceptObjective' as const,
        text,
      }))
    const content = {
      name: representative.name,
      aliases: aliasesOf(members, representative.name),
      summary: representative.summary,
      objectives,
      sourceRefs: refs,
      lessons: lessons.map((_ref) => ({_key: `lesson-${hashParts([_ref]).slice(0, 10)}`, _type: 'reference' as const, _ref})),
    }
    const contentHash = conceptContentHash(content)
    if (unit.proposalId) plan.merges.applied.push({proposalId: unit.proposalId, conceptId, members: absorbed})
    if ((byConceptId.get(conceptId) ?? []).some((doc) => doc.contentHash === contentHash)) {
      plan.unchanged.push(conceptId)
      continue
    }
    plan.drafts.push(
      conceptDraftSchema.parse({
        _id: `drafts.${conceptDocumentId(conceptId)}`,
        _type: 'concept',
        conceptId,
        ...content,
        sourceExcerpt: refs.map((ref) => `[${formatClock(ref.startSeconds)}] ${chunkText.get(ref.chunkId) ?? '(chunk text unavailable)'}`).join('\n'),
        revision: 1,
        reviewStatus: 'needs_review',
        sourceStatus: 'current',
        generation: {
          course: {_type: 'reference', _ref: courseId},
          model,
          promptVersion: CONCEPT_EXTRACTION_PROMPT_VERSION,
          configVersion: CONCEPT_EXTRACTION_CONFIG_VERSION,
          extractionKeys: [...new Set(members.map((member) => member.span.extractionKey))],
          candidateIds: members.map((member) => member.candidate._key).toSorted(),
          role: members.some((member) => member.candidate.role === 'primary') ? 'primary' : 'secondary',
          suppressionKey,
          reconsiders,
          appliedMerges: unit.proposalId ? [unit.proposalId] : undefined,
          contentHash,
          generatedAt: now.toISOString(),
        },
      }),
    )
  }

  const mergeDeletes = new Set(plan.mergeDeletes)
  plan.unreproduced = existing
    .filter(
      (doc) =>
        isDraftId(doc._id) &&
        doc.generationCourse === courseId &&
        doc.reviewStatus === 'needs_review' &&
        !reproduced.has(doc.conceptId) &&
        !mergeDeletes.has(doc._id) &&
        !(byConceptId.get(doc.conceptId) ?? []).some((other) => !isDraftId(other._id)) &&
        !editedSinceGeneration(doc),
    )
    .map((doc) => doc._id)
  return plan
}
