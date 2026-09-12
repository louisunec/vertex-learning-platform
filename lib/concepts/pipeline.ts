import {z} from 'zod'

import type {LessonVideo} from '../assessments/pipeline.ts'
import {buildSpans, type Span} from '../assessments/spans.ts'
import {isStale} from '../assessments/staleness.ts'
import {toSourceChunks, type SourceChunk} from '../evidence/chunks.ts'
import {
  planConcepts,
  type AcceptedMerge,
  type ConceptDraft,
  type ConceptPlan,
  type ExistingConcept,
  type RecordedSpan,
} from './cluster.ts'
import {
  CONSOLIDATION_CONFIG_VERSION,
  CONSOLIDATION_PROMPT_VERSION,
  CONSOLIDATION_SYSTEM_PROMPT,
  MAX_CONSOLIDATION_CONCEPTS,
  buildConsolidationPrompt,
  consolidationKeyFor,
  consolidationOutputSchema,
  estimateConsolidatedCount,
  orderForConsolidation,
  planMergeProposals,
  type ConsolidationConcept,
  type ConsolidationOutput,
  type ExistingProposal,
  type MergeProposalDraft,
  type ProposalPlan,
} from './consolidate.ts'
import {
  CONCEPT_EXTRACTION_CONFIG_VERSION,
  CONCEPT_EXTRACTION_PROMPT_VERSION,
  CONCEPT_EXTRACTION_SYSTEM_PROMPT,
  CONCEPT_FIELD_LIMITS,
  MAX_EXCLUDED_DETAILS,
  buildExtractionPrompt,
  conceptCandidateSchema,
  extractionKeyFor,
  extractionOutputSchema,
  mapConceptCandidate,
  matchKey,
  rejectCandidate,
  rejectedCandidateSchema,
  type ConceptCandidate,
  type ConceptRejection,
  type ExtractionOutput,
  type RejectedCandidate,
} from './extract.ts'
import {
  MAX_PREREQUISITE_CONCEPTS,
  PREREQUISITE_CONFIG_VERSION,
  PREREQUISITE_PROMPT_VERSION,
  PREREQUISITE_SYSTEM_PROMPT,
  buildPrerequisitePrompt,
  orderForPrompt,
  planEdges,
  prerequisiteKeyFor,
  prerequisiteOutputSchema,
  type EdgeConcept,
  type EdgeDraft,
  type EdgePlan,
  type ExistingEdge,
  type PrerequisiteOutput,
} from './prerequisites.ts'

/**
 * Concept pipeline orchestration (development plan §5 PR-3), separated from
 * I/O so tests can count model calls. The CLI (`scripts/generate-concepts.mts`)
 * fetches inputs, supplies `generate`, and executes the returned transactions
 * — or, under `--dry-run`, none of them.
 *
 * Extraction idempotency: every span whose model call returned schema-valid
 * output gets a `conceptGenerationRecord` holding its validated candidates
 * (and, for audit, its rejected ones), keyed by the span's extraction key.
 * Concept drafts are a deterministic projection of every current record of
 * the course plus editor-accepted merge proposals, so an unchanged rerun makes
 * no model call and writes nothing. Provider errors, timeouts, invalid
 * output, and run-cap deferrals leave no record and are retried next run.
 *
 * Nothing here publishes: every write is a `drafts.` document, an
 * operational record, a staleness patch, or the deletion of an unpublished
 * generator draft (unreproduced under `force`, or absorbed by an accepted merge).
 */

type AnyOutput = ExtractionOutput | PrerequisiteOutput | ConsolidationOutput

/** One bounded model call; rejects on provider failure (an `AiCallError` carries a `category`). */
export type ConceptGenerateFn = <T extends AnyOutput>(input: {
  task: 'concept-extraction' | 'concept-prerequisites' | 'concept-consolidation'
  system: string
  prompt: string
  schema: z.ZodType<T>
}) => Promise<T>

const key = z.string().min(1)
const reference = z.object({_type: z.literal('reference'), _ref: key})
const SKIP_REASON_LIMIT = 200

/** Shapes written per processed unit — mirror `studio/schemaTypes/documents/concept-generation-record.ts`. */
export const extractionRecordSchema = z.object({
  _id: z.string().startsWith('concept-generation-'),
  _type: z.literal('conceptGenerationRecord'),
  kind: z.literal('span_extraction'),
  lesson: reference,
  spanIndex: z.number().int().min(0),
  key,
  promptVersion: key,
  model: key,
  configVersion: key,
  outcome: z.enum(['extracted', 'no_candidates', 'all_rejected']),
  candidates: z.array(conceptCandidateSchema).max(2),
  rejectedCandidates: z.array(rejectedCandidateSchema).max(2),
  excludedDetails: z.array(z.string().min(1).max(CONCEPT_FIELD_LIMITS.excludedDetail)).max(MAX_EXCLUDED_DETAILS),
  droppedAliases: z.number().int().min(0),
  rejectionReasons: z.array(key),
  modelSkipReason: z.string().max(SKIP_REASON_LIMIT).optional(),
  processedAt: z.iso.datetime(),
})

export const courseRecordSchema = z.object({
  _id: z.string().startsWith('concept-generation-'),
  _type: z.literal('conceptGenerationRecord'),
  kind: z.enum(['course_prerequisites', 'course_consolidation']),
  course: reference,
  key,
  promptVersion: key,
  model: key,
  configVersion: key,
  outcome: z.enum(['proposed', 'no_candidates', 'all_rejected']),
  draftIds: z.array(key),
  rejectionReasons: z.array(key),
  modelSkipReason: z.string().max(SKIP_REASON_LIMIT).optional(),
  processedAt: z.iso.datetime(),
})

export type ExtractionRecord = z.infer<typeof extractionRecordSchema>
export type CourseRecord = z.infer<typeof courseRecordSchema>

export function conceptRecordId(generationKey: string): string {
  return `concept-generation-${generationKey}`
}

export type ConceptMutation =
  | {createOrReplace: ConceptDraft | EdgeDraft | MergeProposalDraft | ExtractionRecord | CourseRecord}
  | {delete: {id: string}}
  | {patch: {id: string; set: {sourceStatus: 'stale'}}}

function boundedLogText(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  return trimmed.length <= SKIP_REASON_LIMIT ? trimmed : `${trimmed.slice(0, SKIP_REASON_LIMIT - 1)}…`
}

function failureCategory(error: unknown): string {
  const category = (error as {category?: unknown})?.category
  return typeof category === 'string' ? category : 'unknown'
}

/** The video document id a chunk id belongs to (`<video id>:<chunk key>`). */
export function videoIdOfChunk(chunkId: string): string {
  const separator = chunkId.lastIndexOf(':')
  return separator > 0 ? chunkId.slice(0, separator) : ''
}

type Cited = {_id: string; sourceStatus?: string | null; refs?: ReadonlyArray<{chunkId?: string | null; chunkRevision?: string | null}> | null}

/**
 * Ids of documents not yet stale whose refs into the given videos no longer
 * match the current chunks. Refs into other videos are not judged: the run
 * did not read them.
 */
export function findStaleInScope(docs: ReadonlyArray<Cited>, current: ReadonlyArray<SourceChunk>, videoIds: ReadonlySet<string>): string[] {
  return docs
    .filter((doc) => {
      if (doc.sourceStatus === 'stale') return false
      const inScope = (doc.refs ?? []).filter((ref) => ref.chunkId && videoIds.has(videoIdOfChunk(ref.chunkId)))
      return inScope.length > 0 && isStale(inScope, current)
    })
    .map((doc) => doc._id)
}

export type CourseLesson = {
  lesson: {_id: string; title: string}
  /** Position in the course. */
  order: number
  video: LessonVideo | null
  /** Whether this run may call the model for the lesson (`--limit` / `--lesson`); all lessons feed the projection. */
  inScope: boolean
}

export type SpanOutcome = {
  lessonId: string
  spanIndex: number
  status: ExtractionRecord['outcome'] | 'skipped' | 'deferred' | 'failed'
  detail: string
}

export type ExtractionResult = {
  /** Each inner array is one atomic transaction, in order. */
  transactions: ConceptMutation[][]
  spans: SpanOutcome[]
  /** Records written by this run. */
  records: ExtractionRecord[]
  /** Every current recorded span the projection used (new and existing). */
  currentSpans: RecordedSpan[]
  plan: ConceptPlan
  staleIds: string[]
  /** Unreproduced drafts deleted (only under `force`). */
  deletedIds: string[]
  lessonsWithoutTranscript: string[]
  modelCalls: number
}

/**
 * Validates one span's output: the primary, then a secondary only alongside
 * a primary and never the same concept. Rejected candidates keep an audit copy.
 */
function mapSpanOutput(output: ExtractionOutput, context: {lessonId: string; span: Span; extractionKey: string}) {
  const candidates: ConceptCandidate[] = []
  const rejected: RejectedCandidate[] = []
  const reasons: ConceptRejection[] = []
  let droppedAliases = 0
  const take = (mapped: ReturnType<typeof mapConceptCandidate>) => {
    if (mapped.ok) {
      candidates.push(mapped.candidate)
      droppedAliases += mapped.droppedAliases.length
    } else {
      rejected.push(mapped.rejected)
      reasons.push(mapped.reason)
    }
  }
  const base = {lessonId: context.lessonId, span: context.span, extractionKey: context.extractionKey}
  if (output.primary) take(mapConceptCandidate(output.primary, {...base, role: 'primary'}))
  if (output.secondary) {
    const secondaryContext = {...base, role: 'secondary' as const}
    if (!output.primary) take(rejectCandidate(output.secondary, secondaryContext, 'secondary_without_primary'))
    else if (matchKey(output.secondary.name) === matchKey(output.primary.name)) {
      take(rejectCandidate(output.secondary, secondaryContext, 'secondary_duplicates_primary'))
    } else take(mapConceptCandidate(output.secondary, secondaryContext))
  }
  return {candidates, rejected, reasons, droppedAliases}
}

export async function extractCourse(input: {
  course: {_id: string}
  lessons: ReadonlyArray<CourseLesson>
  /** Existing extraction records by key. */
  recorded: ReadonlyMap<string, ExtractionRecord>
  existingConcepts: ReadonlyArray<ExistingConcept & {sourceStatus?: string | null}>
  existingEdges: ReadonlyArray<{_id: string; sourceStatus?: string | null; evidence?: ReadonlyArray<{chunkId: string; chunkRevision: string}> | null}>
  /** Merge proposals an editor accepted in the Studio. */
  acceptedMerges?: ReadonlyArray<AcceptedMerge>
  /** Merge proposals not accepted (rejected, or set back to proposed): members of an already-applied one are restored. */
  rejectedMerges?: ReadonlyArray<AcceptedMerge>
  force: boolean
  model: string
  generate: ConceptGenerateFn
  /** Decremented per model call. */
  budget: {remaining: number}
  now?: () => Date
}): Promise<ExtractionResult> {
  const {course, lessons, recorded, existingConcepts, existingEdges, acceptedMerges = [], rejectedMerges = [], force, model, generate, budget, now = () => new Date()} =
    input
  const result: Omit<ExtractionResult, 'plan'> = {
    transactions: [],
    spans: [],
    records: [],
    currentSpans: [],
    staleIds: [],
    deletedIds: [],
    lessonsWithoutTranscript: [],
    modelCalls: 0,
  }

  const allChunks: SourceChunk[] = []
  const videoIds = new Set<string>()

  for (const {lesson, order, video, inScope} of lessons) {
    const chunks = video ? toSourceChunks(video) : []
    if (!video || chunks.length === 0) {
      result.lessonsWithoutTranscript.push(lesson._id)
      continue
    }
    videoIds.add(video._id)
    allChunks.push(...chunks)

    for (const span of buildSpans(chunks, video.chapters ?? [])) {
      const extractionKey = extractionKeyFor({lessonId: lesson._id, lessonTitle: lesson.title, videoDocumentId: video._id, span, model})
      const existing = recorded.get(extractionKey)
      const recordedSpan = (record: ExtractionRecord): RecordedSpan => ({
        lessonId: lesson._id,
        lessonOrder: order,
        spanIndex: span.index,
        extractionKey,
        candidates: record.candidates,
      })
      if (!inScope || (existing && !force)) {
        if (existing) result.currentSpans.push(recordedSpan(existing))
        if (inScope) result.spans.push({lessonId: lesson._id, spanIndex: span.index, status: 'skipped', detail: 'already extracted with this source and prompt'})
        continue
      }
      if (budget.remaining <= 0) {
        if (existing) result.currentSpans.push(recordedSpan(existing))
        result.spans.push({lessonId: lesson._id, spanIndex: span.index, status: 'deferred', detail: 'run model-call cap reached'})
        continue
      }
      budget.remaining--
      result.modelCalls++

      let output: ExtractionOutput
      try {
        output = await generate({
          task: 'concept-extraction',
          system: CONCEPT_EXTRACTION_SYSTEM_PROMPT,
          prompt: buildExtractionPrompt({lessonTitle: lesson.title, span}),
          schema: extractionOutputSchema,
        })
      } catch (error) {
        if (existing) result.currentSpans.push(recordedSpan(existing))
        result.spans.push({
          lessonId: lesson._id,
          spanIndex: span.index,
          status: 'failed',
          detail: `model call failed (${failureCategory(error)}); not recorded, retried next run`,
        })
        continue
      }

      const {candidates, rejected, reasons, droppedAliases} = mapSpanOutput(output, {lessonId: lesson._id, span, extractionKey})
      const excludedDetails = output.excludedDetails
        .map((detail) => detail.trim())
        .filter((detail) => detail.length > 0 && detail.length <= CONCEPT_FIELD_LIMITS.excludedDetail)
        .slice(0, MAX_EXCLUDED_DETAILS)
      const outcome = candidates.length > 0 ? 'extracted' : rejected.length > 0 ? 'all_rejected' : 'no_candidates'
      const record = extractionRecordSchema.parse({
        _id: conceptRecordId(extractionKey),
        _type: 'conceptGenerationRecord',
        kind: 'span_extraction',
        lesson: {_type: 'reference', _ref: lesson._id},
        spanIndex: span.index,
        key: extractionKey,
        promptVersion: CONCEPT_EXTRACTION_PROMPT_VERSION,
        model,
        configVersion: CONCEPT_EXTRACTION_CONFIG_VERSION,
        outcome,
        candidates,
        rejectedCandidates: rejected,
        excludedDetails,
        droppedAliases,
        rejectionReasons: reasons,
        modelSkipReason: boundedLogText(output.skipReason),
        processedAt: now().toISOString(),
      })
      result.records.push(record)
      result.transactions.push([{createOrReplace: record}])
      result.currentSpans.push(recordedSpan(record))
      const rejectedNote = reasons.length > 0 ? `; rejected: ${reasons.join(', ')}` : ''
      result.spans.push({
        lessonId: lesson._id,
        spanIndex: span.index,
        status: outcome,
        detail:
          outcome === 'extracted'
            ? `${candidates.map((candidate) => `${candidate.role === 'secondary' ? '+' : ''}${JSON.stringify(candidate.name)}`).join(', ')}${rejectedNote}`
            : outcome === 'no_candidates'
              ? `model: ${record.modelSkipReason ?? 'no concepts'}`
              : `all candidates rejected${rejectedNote}`,
      })
    }
  }

  const staleConcepts = findStaleInScope(
    existingConcepts.map((doc) => ({_id: doc._id, sourceStatus: doc.sourceStatus, refs: doc.sourceRefs})),
    allChunks,
    videoIds,
  )
  const staleEdges = findStaleInScope(
    existingEdges.map((doc) => ({_id: doc._id, sourceStatus: doc.sourceStatus, refs: doc.evidence})),
    allChunks,
    videoIds,
  )
  result.staleIds = [...staleConcepts, ...staleEdges]
  if (result.staleIds.length > 0) {
    result.transactions.unshift(result.staleIds.map((id) => ({patch: {id, set: {sourceStatus: 'stale' as const}}})))
  }

  const plan = planConcepts({
    spans: result.currentSpans,
    existing: existingConcepts,
    courseId: course._id,
    model,
    chunkText: new Map(allChunks.map((chunk) => [chunk.chunkId, chunk.text])),
    now: now(),
    acceptedMerges,
    rejectedMerges,
  })
  result.deletedIds = force ? plan.unreproduced : []
  const writes: ConceptMutation[] = [
    ...plan.drafts.map((doc) => ({createOrReplace: doc})),
    ...plan.mergeDeletes.map((id) => ({delete: {id}})),
    ...result.deletedIds.map((id) => ({delete: {id}})),
  ]
  if (writes.length > 0) result.transactions.push(writes)
  return {...result, plan}
}

export type CourseStepStatus = 'proposed' | 'no_candidates' | 'all_rejected' | 'skipped' | 'refused' | 'failed'

export type PrerequisiteResult = {
  status: CourseStepStatus
  detail: string
  transactions: ConceptMutation[][]
  plan: EdgePlan | null
  record: CourseRecord | null
  modelCalls: number
}

function idle<P>(status: CourseStepStatus, detail: string, modelCalls = 0) {
  return {status, detail, transactions: [] as ConceptMutation[][], plan: null as P | null, record: null, modelCalls}
}

function courseRecord(input: {
  kind: CourseRecord['kind']
  courseId: string
  generationKey: string
  promptVersion: string
  configVersion: string
  model: string
  outcome: CourseRecord['outcome']
  draftIds: string[]
  rejectionReasons: string[]
  skipReason: string | null
  processedAt: Date
}): CourseRecord {
  return courseRecordSchema.parse({
    _id: conceptRecordId(input.generationKey),
    _type: 'conceptGenerationRecord',
    kind: input.kind,
    course: {_type: 'reference', _ref: input.courseId},
    key: input.generationKey,
    promptVersion: input.promptVersion,
    model: input.model,
    configVersion: input.configVersion,
    outcome: input.outcome,
    draftIds: input.draftIds,
    rejectionReasons: input.rejectionReasons,
    modelSkipReason: boundedLogText(input.skipReason),
    processedAt: input.processedAt.toISOString(),
  })
}

/**
 * One course-level proposal call over at most `MAX_PREREQUISITE_CONCEPTS`
 * concepts (refused, never truncated, above that). The edge drafts and the
 * record are written in one transaction; reruns with the same key skip unless
 * `force`.
 */
export async function proposePrerequisites(input: {
  course: {_id: string; title: string}
  concepts: ReadonlyArray<EdgeConcept>
  existingEdges: ReadonlyArray<ExistingEdge>
  activeEdges: ReadonlyArray<{prerequisite: string; dependent: string}>
  recordedKeys: ReadonlySet<string>
  force: boolean
  model: string
  generate: ConceptGenerateFn
  now?: () => Date
}): Promise<PrerequisiteResult> {
  const {course, existingEdges, activeEdges, recordedKeys, force, model, generate, now = () => new Date()} = input
  if (input.concepts.length < 2) return idle<EdgePlan>('skipped', `${input.concepts.length} concept(s): nothing to relate`)
  if (input.concepts.length > MAX_PREREQUISITE_CONCEPTS) {
    return idle<EdgePlan>(
      'refused',
      `${input.concepts.length} concepts exceed the ${MAX_PREREQUISITE_CONCEPTS}-concept bound of one call; narrow the scope`,
    )
  }
  const concepts = orderForPrompt(input.concepts)
  const generationKey = prerequisiteKeyFor({courseId: course._id, concepts, model})
  if (recordedKeys.has(generationKey) && !force) return idle<EdgePlan>('skipped', 'already proposed for these concepts and prompt')

  let output: PrerequisiteOutput
  try {
    output = await generate({
      task: 'concept-prerequisites',
      system: PREREQUISITE_SYSTEM_PROMPT,
      prompt: buildPrerequisitePrompt({courseTitle: course.title, concepts}),
      schema: prerequisiteOutputSchema,
    })
  } catch (error) {
    return idle<EdgePlan>('failed', `model call failed (${failureCategory(error)}); not recorded, retried next run`, 1)
  }

  const processedAt = now()
  const plan = planEdges({output, concepts, existing: existingEdges, activeEdges, courseId: course._id, generationKey, model, now: processedAt})
  const accepted = plan.drafts.length + plan.unchanged.length
  const status = accepted > 0 ? 'proposed' : plan.rejections.length > 0 ? 'all_rejected' : 'no_candidates'
  const record = courseRecord({
    kind: 'course_prerequisites',
    courseId: course._id,
    generationKey,
    promptVersion: PREREQUISITE_PROMPT_VERSION,
    configVersion: PREREQUISITE_CONFIG_VERSION,
    model,
    outcome: status,
    draftIds: plan.drafts.map((draft) => draft._id),
    rejectionReasons: plan.rejections.map((rejection) => `${rejection.reason}|${rejection.pair}`),
    skipReason: output.skipReason,
    processedAt,
  })
  return {
    status,
    detail:
      status === 'no_candidates'
        ? `model: ${record.modelSkipReason ?? 'no edges'}`
        : `${plan.drafts.length} draft(s), ${plan.unchanged.length} unchanged, ${plan.rejections.length} rejected, ${plan.reconsidered.length} reconsidered, ${plan.cycles.length} cycle(s)`,
    transactions: [[...plan.drafts.map((doc) => ({createOrReplace: doc})), {createOrReplace: record}]],
    plan,
    record,
    modelCalls: 1,
  }
}

export type ConsolidationResult = {
  status: CourseStepStatus
  detail: string
  transactions: ConceptMutation[][]
  plan: ProposalPlan | null
  record: CourseRecord | null
  modelCalls: number
  /** Concept count if every non-suppressed proposal were accepted. */
  estimatedCount: number | null
}

/**
 * One course-level duplicate-proposal call over at most
 * `MAX_CONSOLIDATION_CONCEPTS` concepts (refused, never truncated, above
 * that). Proposal drafts (status "proposed") and the record are written in
 * one transaction; reruns with the same key skip unless `force`. Nothing is
 * merged here.
 */
export async function proposeMerges(input: {
  course: {_id: string; title: string}
  concepts: ReadonlyArray<ConsolidationConcept>
  existingProposals: ReadonlyArray<ExistingProposal>
  recordedKeys: ReadonlySet<string>
  force: boolean
  model: string
  generate: ConceptGenerateFn
  now?: () => Date
}): Promise<ConsolidationResult> {
  const {course, existingProposals, recordedKeys, force, model, generate, now = () => new Date()} = input
  const withEstimate = (result: ReturnType<typeof idle<ProposalPlan>>): ConsolidationResult => ({...result, estimatedCount: null})
  if (input.concepts.length < 2) return withEstimate(idle<ProposalPlan>('skipped', `${input.concepts.length} concept(s): nothing to consolidate`))
  if (input.concepts.length > MAX_CONSOLIDATION_CONCEPTS) {
    return withEstimate(
      idle<ProposalPlan>(
        'refused',
        `${input.concepts.length} concepts exceed the ${MAX_CONSOLIDATION_CONCEPTS}-concept bound of one call; narrow the scope`,
      ),
    )
  }
  const concepts = orderForConsolidation(input.concepts)
  const generationKey = consolidationKeyFor({courseId: course._id, concepts, model})
  if (recordedKeys.has(generationKey) && !force) {
    return withEstimate(idle<ProposalPlan>('skipped', 'already consolidated for these concepts and prompt'))
  }

  let output: ConsolidationOutput
  try {
    output = await generate({
      task: 'concept-consolidation',
      system: CONSOLIDATION_SYSTEM_PROMPT,
      prompt: buildConsolidationPrompt({courseTitle: course.title, concepts}),
      schema: consolidationOutputSchema,
    })
  } catch (error) {
    return withEstimate(idle<ProposalPlan>('failed', `model call failed (${failureCategory(error)}); not recorded, retried next run`, 1))
  }

  const processedAt = now()
  const plan = planMergeProposals({output, concepts, existing: existingProposals, courseId: course._id, generationKey, model, now: processedAt})
  const status = plan.groups.length > 0 ? 'proposed' : plan.rejections.length > 0 ? 'all_rejected' : 'no_candidates'
  const record = courseRecord({
    kind: 'course_consolidation',
    courseId: course._id,
    generationKey,
    promptVersion: CONSOLIDATION_PROMPT_VERSION,
    configVersion: CONSOLIDATION_CONFIG_VERSION,
    model,
    outcome: status,
    draftIds: plan.drafts.map((draft) => draft._id),
    rejectionReasons: plan.rejections.map((rejection) => `${rejection.reason}|${rejection.group}`),
    skipReason: output.skipReason,
    processedAt,
  })
  const estimatedCount = estimateConsolidatedCount(concepts.length, plan.groups)
  return {
    status,
    detail:
      status === 'no_candidates'
        ? `model: ${record.modelSkipReason ?? 'no groups'}`
        : `${plan.groups.length} merge group(s): ${plan.drafts.length} draft(s), ${plan.unchanged.length} unchanged, ${plan.rejections.length} rejected; ${concepts.length} → ~${estimatedCount} concepts if all are accepted`,
    transactions: [[...plan.drafts.map((doc) => ({createOrReplace: doc})), {createOrReplace: record}]],
    plan,
    record,
    modelCalls: 1,
    estimatedCount,
  }
}
