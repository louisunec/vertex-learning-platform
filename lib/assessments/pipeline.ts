import {z} from 'zod'

import {toSourceChunks, type StoredChunk} from '../evidence/chunks.ts'
import {
  ASSESSMENT_PROMPT_VERSION,
  ASSESSMENT_SYSTEM_PROMPT,
  GENERATOR_CONFIG_VERSION,
  TRANSFER_SYSTEM_PROMPT,
  buildGenerationPrompt,
  chooseTransferSpan,
  mapCandidate,
  planGeneration,
  sectionFamilyIds,
  spanKeyFor,
  transferFamilyId,
  transferKeyFor,
  generationOutputSchema,
  transferOutputSchema,
  type AssessmentDraft,
  type CandidateRejection,
  type ExistingVersion,
  type GeneratedItem,
} from './generate.ts'
import {buildSpans, type Span} from './spans.ts'
import {findNewlyStale} from './staleness.ts'

/**
 * Per-lesson generation orchestration (development plan §5 PR-1), separated
 * from I/O so tests can count model calls. The CLI fetches inputs, supplies
 * `generate`, and executes the returned transactions.
 *
 * A lesson is processed as units: one per section (recall/apply items) plus
 * one lesson-level transfer unit over a deterministically chosen section, so
 * every lesson with a transcript gets a transfer attempt.
 *
 * Idempotency: every unit whose model call returned a schema-valid response
 * gets an `assessmentGenerationRecord` keyed by its generation key (section
 * identity — lesson, video, ordered chunk revisions — plus prompt, model, and
 * config versions; transfer keys add a fixed suffix), written in the same
 * transaction as its drafts. Reruns skip recorded units, including those that
 * produced no candidates or only rejected ones, unless `force` is set.
 * Provider errors, timeouts, invalid output, and run-cap deferrals are not
 * deterministic outcomes, so they leave no record and are retried next run.
 *
 * Regeneration replaces a family's unpublished draft in place instead of
 * adding a version beside it. Under `force`, unpublished drafts of the unit
 * that the new output does not reproduce are deleted. Published versions are
 * never written.
 */

export type GenerationOutput = {items: GeneratedItem[]; skipReason: string | null}
export type GenerationKind = 'section' | 'lesson_transfer'
/** One bounded model call; rejects on provider failure (an `AiCallError` carries a `category`). */
export type GenerateFn = (input: {
  kind: GenerationKind
  system: string
  prompt: string
  schema: z.ZodType<GenerationOutput>
}) => Promise<GenerationOutput>

export type GenerationOutcome = 'drafted' | 'no_candidates' | 'all_rejected'

const key = z.string().min(1)
const SKIP_REASON_LIMIT = 200

/** Shape written per processed unit — mirrors `studio/schemaTypes/documents/assessment-generation-record.ts`. */
export const generationRecordSchema = z.object({
  _id: z.string().startsWith('assessment-generation-'),
  _type: z.literal('assessmentGenerationRecord'),
  kind: z.enum(['section', 'lesson_transfer']),
  lesson: z.object({_type: z.literal('reference'), _ref: key}),
  spanIndex: z.number().int().min(0),
  spanKey: key,
  promptVersion: key,
  model: key,
  configVersion: key,
  outcome: z.enum(['drafted', 'no_candidates', 'all_rejected']),
  draftIds: z.array(key),
  rejectionReasons: z.array(key),
  modelSkipReason: z.string().max(SKIP_REASON_LIMIT).optional(),
  processedAt: z.iso.datetime(),
})

export type GenerationRecord = z.infer<typeof generationRecordSchema>

/** Operator-only log text: shortened visibly with "…", never silently cut. */
function boundedLogText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
}

export function generationRecordId(generationKey: string): string {
  return `assessment-generation-${generationKey}`
}

export type Mutation =
  | {createOrReplace: AssessmentDraft | GenerationRecord}
  | {delete: {id: string}}
  | {patch: {id: string; set: {sourceStatus: 'stale'}}}

export type SectionOutcome = {
  kind: GenerationKind
  spanIndex: number
  status: GenerationOutcome | 'skipped' | 'deferred' | 'failed'
  detail: string
}

export type LessonResult = {
  /** Each inner array is one atomic transaction, in order. */
  transactions: Mutation[][]
  sections: SectionOutcome[]
  drafts: AssessmentDraft[]
  records: GenerationRecord[]
  staleIds: string[]
  /** Unpublished drafts replaced in place (same id). */
  replacedIds: string[]
  /** Unpublished drafts deleted by `force` because the new output did not reproduce them. */
  deletedIds: string[]
  modelCalls: number
  /** Set when the lesson has nothing to generate from. */
  skipReason: string | null
}

export type LessonVideo = {
  _id: string
  durationSeconds?: number | null
  chapters?: Array<{startSeconds: number; label: string}> | null
  transcriptChunks?: StoredChunk[] | null
}

type Unit = {
  kind: GenerationKind
  span: Span
  key: string
  familyIds: string[]
  system: string
  schema: z.ZodType<GenerationOutput>
}

export async function processLesson(input: {
  lesson: {_id: string; title: string}
  video: LessonVideo | null
  existing: ReadonlyArray<ExistingVersion>
  /** Generation keys that already have a record. */
  processedSpanKeys: ReadonlySet<string>
  force: boolean
  model: string
  generate: GenerateFn
  /** Shared across lessons in one run; decremented per model call. */
  budget: {remaining: number}
  now?: () => Date
}): Promise<LessonResult> {
  const {lesson, video, existing, processedSpanKeys, force, model, generate, budget, now = () => new Date()} = input
  const result: LessonResult = {
    transactions: [],
    sections: [],
    drafts: [],
    records: [],
    staleIds: [],
    replacedIds: [],
    deletedIds: [],
    modelCalls: 0,
    skipReason: null,
  }

  const chunks = video ? toSourceChunks(video) : []
  result.staleIds = findNewlyStale(existing, chunks)
  if (result.staleIds.length > 0) {
    result.transactions.push(result.staleIds.map((id) => ({patch: {id, set: {sourceStatus: 'stale' as const}}})))
  }
  if (!video || chunks.length === 0) {
    result.skipReason = 'no ingested transcript chunks'
    return result
  }

  const spans = buildSpans(chunks, video.chapters ?? [])
  const keyInput = (span: Span) => ({lessonId: lesson._id, videoDocumentId: video._id, span, model})
  const units: Unit[] = spans.map((span) => ({
    kind: 'section',
    span,
    key: spanKeyFor(keyInput(span)),
    familyIds: sectionFamilyIds(lesson._id, span.index),
    system: ASSESSMENT_SYSTEM_PROMPT,
    schema: generationOutputSchema,
  }))
  const transferSpan = chooseTransferSpan(spans)
  if (transferSpan) {
    units.push({
      kind: 'lesson_transfer',
      span: transferSpan,
      key: transferKeyFor(keyInput(transferSpan)),
      familyIds: [transferFamilyId(lesson._id)],
      system: TRANSFER_SYSTEM_PROMPT,
      schema: transferOutputSchema,
    })
  }

  for (const unit of units) {
    const {kind, span} = unit
    const plan = planGeneration({key: unit.key, familyIds: unit.familyIds, existing, processedKeys: processedSpanKeys, force})
    if (plan.action === 'skip') {
      result.sections.push({kind, spanIndex: span.index, status: 'skipped', detail: 'already processed with this source and prompt'})
      continue
    }
    if (budget.remaining <= 0) {
      result.sections.push({kind, spanIndex: span.index, status: 'deferred', detail: 'run model-call cap reached'})
      continue
    }
    budget.remaining--
    result.modelCalls++

    let output: GenerationOutput
    try {
      output = await generate({
        kind,
        system: unit.system,
        prompt: buildGenerationPrompt({lessonTitle: lesson.title, span}),
        schema: unit.schema,
      })
    } catch (error) {
      const category = (error as {category?: unknown})?.category
      result.sections.push({
        kind,
        spanIndex: span.index,
        status: 'failed',
        detail: `model call failed (${typeof category === 'string' ? category : 'unknown'}); not recorded, retried next run`,
      })
      continue
    }

    const processedAt = now()
    const drafts: AssessmentDraft[] = []
    const rejectionReasons: CandidateRejection[] = []
    output.items.slice(0, plan.targets.length).forEach((item, ordinal) => {
      const target = plan.targets[ordinal]
      const mapped = mapCandidate(item, {
        lessonId: lesson._id,
        span,
        spanKey: unit.key,
        familyId: target.familyId,
        ordinal,
        version: target.version,
        model,
        generatedAt: processedAt,
      })
      if (mapped.ok) drafts.push(mapped.doc)
      else rejectionReasons.push(mapped.reason)
    })

    const draftIds = new Set(drafts.map((draft) => draft._id))
    const replaced = plan.targets.flatMap((target) =>
      target.replacesDraftId && draftIds.has(target.replacesDraftId) ? [target.replacesDraftId] : [],
    )
    const deleted = force
      ? plan.targets.flatMap((target) =>
          target.replacesDraftId && !draftIds.has(target.replacesDraftId) ? [target.replacesDraftId] : [],
        )
      : []

    const outcome: GenerationOutcome =
      drafts.length > 0 ? 'drafted' : rejectionReasons.length > 0 ? 'all_rejected' : 'no_candidates'
    const record = generationRecordSchema.parse({
      _id: generationRecordId(unit.key),
      _type: 'assessmentGenerationRecord',
      kind,
      lesson: {_type: 'reference', _ref: lesson._id},
      spanIndex: span.index,
      spanKey: unit.key,
      promptVersion: ASSESSMENT_PROMPT_VERSION,
      model,
      configVersion: GENERATOR_CONFIG_VERSION,
      outcome,
      draftIds: [...draftIds],
      rejectionReasons,
      modelSkipReason: output.skipReason?.trim() ? boundedLogText(output.skipReason.trim(), SKIP_REASON_LIMIT) : undefined,
      processedAt: processedAt.toISOString(),
    })

    result.transactions.push([
      ...drafts.map((doc) => ({createOrReplace: doc})),
      ...deleted.map((id) => ({delete: {id}})),
      {createOrReplace: record},
    ])
    result.drafts.push(...drafts)
    result.records.push(record)
    result.replacedIds.push(...replaced)
    result.deletedIds.push(...deleted)
    const notes = [
      rejectionReasons.length > 0 ? `rejected: ${rejectionReasons.join(', ')}` : null,
      replaced.length > 0 ? `replaced ${replaced.length} unpublished draft(s)` : null,
      deleted.length > 0 ? `deleted ${deleted.length} unpublished draft(s)` : null,
    ].filter(Boolean)
    const suffix = notes.length > 0 ? `; ${notes.join('; ')}` : ''
    result.sections.push({
      kind,
      spanIndex: span.index,
      status: outcome,
      detail:
        outcome === 'drafted'
          ? `${drafts.length} draft(s) ${drafts.map((doc) => `${doc.type}/v${doc.version}`).join(' ')}${suffix}`
          : outcome === 'no_candidates'
            ? `model: ${record.modelSkipReason ?? 'no items'}${suffix}`
            : `all candidates rejected${suffix}`,
    })
  }
  return result
}
