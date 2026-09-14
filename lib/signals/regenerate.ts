import type postgres from 'postgres'

import {assessmentDocumentId, sectionFamilyIds, transferFamilyId, type ExistingVersion} from '../assessments/generate.ts'
import {processLesson, type GenerateFn, type GenerationKind, type LessonVideo, type Mutation as PipelineMutation} from '../assessments/pipeline.ts'
import {asSignalsWorker, type WorkerTx} from '../db/worker-scope.ts'
import type {AssessmentSource} from './sanity-store.ts'

/**
 * Draft regeneration candidates queued by editorial signals (development
 * plan §5 PR-10), in `editorial.regeneration_candidate` (migration 0007).
 *
 * Queueing: only an assessment-difficulty signal that met its threshold,
 * at most one candidate per source revision (the assessment's generation
 * span key) per UTC day (a unique index), and at most `dailyCap` a day in
 * total. A high error rate alone never publishes anything.
 *
 * Execution (`npm run signals -- regenerate --execute`) is off unless
 * `SIGNALS_REGENERATION_ENABLED=true`. It reuses the PR-1 generator
 * (`processLesson`) for the flagged unit only, and every write passes
 * `assertDraftOnlyWrites`:
 *
 * - the unit is skipped when any of its families has an unpublished draft,
 *   so an editor's draft is never replaced or deleted;
 * - the unit is skipped when a newer version than the flagged one exists;
 * - assessment writes are `createOrReplace` of `drafts.` ids at a version
 *   above every existing one, with `reviewStatus: 'needs_review'`;
 * - the only other write is the unit's generation record;
 * - no delete, no patch, and no write to a published document.
 *
 * Published versions, approvals, attempts, and grades are never touched.
 */

export const REGENERATION_DEFAULTS = {dailyCap: 5, perRun: 2, leaseSeconds: 15 * 60, maxAttempts: 3} as const

export type QueueRequest = {signalId: string; assessmentId: string; lessonId: string | null; familyId: string; version: number}

export type QueueResult =
  | {status: 'queued'; candidateId: string; queuedDay: string}
  | {status: 'duplicate'; candidateId: string; queuedDay: string}
  | {status: 'skipped'; reason: 'daily_cap' | 'no_source_key' | 'no_lesson'}

const utcDay = (now: Date) => now.toISOString().slice(0, 10)

/** Serializes queueing so the daily cap holds across concurrent runs. */
const QUEUE_LOCK = 'vertex:editorial:regeneration-queue'

export async function queueRegeneration(
  db: postgres.Sql,
  request: QueueRequest,
  source: AssessmentSource | null,
  {now, dailyCap = REGENERATION_DEFAULTS.dailyCap}: {now: Date; dailyCap?: number},
): Promise<QueueResult> {
  const lessonId = source?.lessonId ?? request.lessonId
  if (!source?.spanKey) return {status: 'skipped', reason: 'no_source_key'}
  if (!lessonId) return {status: 'skipped', reason: 'no_lesson'}
  const day = utcDay(now)
  return asSignalsWorker(db, async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${QUEUE_LOCK}, 0))`
    const [existing] = await tx<{id: string}[]>`
      select id from editorial.regeneration_candidate where source_key = ${source.spanKey} and queued_day = ${day}
    `
    if (existing) return {status: 'duplicate', candidateId: existing.id, queuedDay: day} as const
    const [{count}] = await tx<{count: number}[]>`
      select count(*)::int as count from editorial.regeneration_candidate where queued_day = ${day}
    `
    if (count >= dailyCap) return {status: 'skipped', reason: 'daily_cap'} as const
    const [row] = await tx<{id: string}[]>`
      insert into editorial.regeneration_candidate
        (source_key, queued_day, signal_id, lesson_id, family_id, assessment_id, assessment_version)
      values (${source.spanKey}, ${day}, ${request.signalId}, ${lessonId}, ${request.familyId}, ${request.assessmentId}, ${request.version})
      returning id
    `
    return {status: 'queued', candidateId: row.id, queuedDay: day} as const
  })
}

export type CandidateRow = {
  id: string
  sourceKey: string
  queuedDay: string
  signalId: string
  lessonId: string
  familyId: string
  assessmentId: string
  assessmentVersion: number
  status: string
  attempts: number
  lastError: string | null
  result: Record<string, unknown>
  createdAt: Date
}

const CANDIDATE_COLUMNS = (tx: WorkerTx) => tx`
  id, source_key as "sourceKey", queued_day::text as "queuedDay", signal_id as "signalId", lesson_id as "lessonId",
  family_id as "familyId", assessment_id as "assessmentId", assessment_version as "assessmentVersion",
  status, attempts, last_error as "lastError", result, created_at as "createdAt"
`

export async function listCandidates(db: postgres.Sql, {limit = 50}: {limit?: number} = {}): Promise<CandidateRow[]> {
  return asSignalsWorker(
    db,
    (tx) => tx<CandidateRow[]>`select ${CANDIDATE_COLUMNS(tx)} from editorial.regeneration_candidate order by created_at desc limit ${limit}`,
  )
}

/** Claims one queued candidate (or one whose lease expired) for this worker. */
export async function claimCandidate(
  db: postgres.Sql,
  workerId: string,
  {leaseSeconds = REGENERATION_DEFAULTS.leaseSeconds, maxAttempts = REGENERATION_DEFAULTS.maxAttempts} = {},
): Promise<CandidateRow | null> {
  const [row] = await asSignalsWorker(
    db,
    (tx) => tx<CandidateRow[]>`
      with next as (
        select id as next_id from editorial.regeneration_candidate
        where attempts < ${maxAttempts}
          and (status = 'queued' or (status = 'running' and claimed_until < now()))
        order by created_at limit 1
        for update skip locked
      )
      update editorial.regeneration_candidate c
      set status = 'running', claimed_by = ${workerId}, claimed_until = now() + make_interval(secs => ${leaseSeconds}),
          attempts = c.attempts + 1, updated_at = now()
      from next where c.id = next.next_id
      returning ${CANDIDATE_COLUMNS(tx)}
    `,
  )
  return row ?? null
}

export async function finishCandidate(
  db: postgres.Sql,
  workerId: string,
  id: string,
  outcome: {status: 'drafted' | 'skipped' | 'failed' | 'queued'; result?: Record<string, unknown>; error?: string | null},
): Promise<void> {
  await asSignalsWorker(
    db,
    (tx) => tx`
      update editorial.regeneration_candidate
      set status = ${outcome.status}, result = ${tx.json((outcome.result ?? {}) as never)},
          last_error = ${outcome.error?.slice(0, 500) ?? null}, claimed_by = null, claimed_until = null, updated_at = now()
      where id = ${id} and claimed_by = ${workerId}
    `,
  )
}

/** The generator unit a family id belongs to (`asm-<hash>-s<span>-q<n>` or `asm-<hash>-t-q0`). */
export function unitOfFamily(familyId: string): {kind: GenerationKind; spanIndex: number | null} | null {
  const section = /^asm-[0-9a-f]{8}-s(\d+)-q\d+$/.exec(familyId)
  if (section) return {kind: 'section', spanIndex: Number(section[1])}
  if (/^asm-[0-9a-f]{8}-t-q0$/.test(familyId)) return {kind: 'lesson_transfer', spanIndex: null}
  return null
}

const isDraftId = (id: string) => /^(drafts|versions)\./.test(id)

export type RegenerationPlan =
  | {action: 'skip'; reason: 'unknown_unit' | 'draft_pending_review' | 'newer_version_exists' | 'flagged_version_missing'}
  | {action: 'generate'; kind: GenerationKind; spanIndex: number | null; familyIds: string[]}

/** Decides, before any model call, whether the flagged unit may be regenerated. */
export function planRegeneration(candidate: Pick<CandidateRow, 'lessonId' | 'familyId' | 'assessmentVersion'>, existing: ReadonlyArray<ExistingVersion>): RegenerationPlan {
  const unit = unitOfFamily(candidate.familyId)
  if (!unit) return {action: 'skip', reason: 'unknown_unit'}
  const familyIds =
    unit.kind === 'section' && unit.spanIndex !== null ? sectionFamilyIds(candidate.lessonId, unit.spanIndex) : [transferFamilyId(candidate.lessonId)]
  if (!familyIds.includes(candidate.familyId)) return {action: 'skip', reason: 'unknown_unit'}
  const ofUnit = existing.filter((doc) => familyIds.includes(doc.familyId))
  if (ofUnit.some((doc) => isDraftId(doc._id))) return {action: 'skip', reason: 'draft_pending_review'}
  const flagged = ofUnit.filter((doc) => doc.familyId === candidate.familyId)
  if (!flagged.some((doc) => doc._id === assessmentDocumentId(candidate.familyId, candidate.assessmentVersion))) {
    return {action: 'skip', reason: 'flagged_version_missing'}
  }
  if (flagged.some((doc) => doc.version > candidate.assessmentVersion)) return {action: 'skip', reason: 'newer_version_exists'}
  return {action: 'generate', kind: unit.kind, spanIndex: unit.spanIndex, familyIds}
}

export class UnsafeRegenerationWrite extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeRegenerationWrite'
  }
}

/**
 * Throws unless every mutation is a new unpublished assessment draft for the
 * unit, pending review, or the unit's generation record.
 */
export function assertDraftOnlyWrites(
  transactions: ReadonlyArray<ReadonlyArray<PipelineMutation>>,
  {existing, familyIds}: {existing: ReadonlyArray<ExistingVersion>; familyIds: ReadonlyArray<string>},
): void {
  const latest = new Map<string, number>()
  for (const doc of existing) latest.set(doc.familyId, Math.max(latest.get(doc.familyId) ?? 0, doc.version))
  for (const mutation of transactions.flat()) {
    if (!('createOrReplace' in mutation)) throw new UnsafeRegenerationWrite(`regeneration may not ${Object.keys(mutation)[0]} a document`)
    const doc = mutation.createOrReplace as {_id: string; _type: string; familyId?: string; version?: number; reviewStatus?: string}
    if (doc._type === 'assessmentGenerationRecord') continue
    if (doc._type !== 'assessment') throw new UnsafeRegenerationWrite(`unexpected document type ${doc._type}`)
    if (!doc._id.startsWith('drafts.')) throw new UnsafeRegenerationWrite(`${doc._id} is not a draft`)
    if (!doc.familyId || !familyIds.includes(doc.familyId)) throw new UnsafeRegenerationWrite(`${doc._id} is outside the flagged unit`)
    if (!(typeof doc.version === 'number' && doc.version > (latest.get(doc.familyId) ?? 0))) {
      throw new UnsafeRegenerationWrite(`${doc._id} would overwrite an existing version`)
    }
    if (doc.reviewStatus !== 'needs_review') throw new UnsafeRegenerationWrite(`${doc._id} must await review`)
  }
}

export type RegenerationInputs = {
  lesson: {_id: string; title: string}
  video: LessonVideo | null
  existing: ExistingVersion[]
  recordedKeys: string[]
}

export type RegenerationIO = {
  loadInputs(lessonId: string): Promise<RegenerationInputs | null>
  generate: GenerateFn
  model: string
  /** Commits one generator transaction atomically. */
  commit(transaction: PipelineMutation[]): Promise<void>
}

export type ExecutionOutcome = {
  status: 'drafted' | 'skipped' | 'failed'
  reason: string | null
  draftIds: string[]
  modelCalls: number
}

/** Regenerates one claimed candidate's unit as new drafts, or explains why not. */
export async function executeCandidate(
  candidate: Pick<CandidateRow, 'lessonId' | 'familyId' | 'assessmentVersion'>,
  io: RegenerationIO,
  {maxModelCalls = REGENERATION_DEFAULTS.perRun}: {maxModelCalls?: number} = {},
): Promise<ExecutionOutcome> {
  const inputs = await io.loadInputs(candidate.lessonId)
  if (!inputs) return {status: 'skipped', reason: 'lesson_unavailable', draftIds: [], modelCalls: 0}
  const plan = planRegeneration(candidate, inputs.existing)
  if (plan.action === 'skip') return {status: 'skipped', reason: plan.reason, draftIds: [], modelCalls: 0}

  const result = await processLesson({
    lesson: inputs.lesson,
    video: inputs.video,
    existing: inputs.existing,
    processedSpanKeys: new Set(inputs.recordedKeys),
    force: true,
    model: io.model,
    generate: io.generate,
    budget: {remaining: maxModelCalls},
    unitFilter: (unit) => unit.kind === plan.kind && (plan.kind === 'lesson_transfer' || unit.spanIndex === plan.spanIndex),
    markStale: false,
  })
  assertDraftOnlyWrites(result.transactions, {existing: inputs.existing, familyIds: plan.familyIds})
  for (const transaction of result.transactions) await io.commit(transaction)

  const draftIds = result.drafts.map((draft) => draft._id)
  if (draftIds.length > 0) return {status: 'drafted', reason: null, draftIds, modelCalls: result.modelCalls}
  const section = result.sections[0]
  const failed = !section || section.status === 'failed' || section.status === 'deferred'
  return {status: failed ? 'failed' : 'skipped', reason: section ? `${section.status}: ${section.detail}` : 'unit_not_found', draftIds, modelCalls: result.modelCalls}
}
