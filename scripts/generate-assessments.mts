import {writeFile} from 'node:fs/promises'

import {openai, type OpenAILanguageModelResponsesOptions} from '@ai-sdk/openai'

import {generateBoundedObject} from '../lib/ai/gateway.ts'
import {ASSESSMENT_PROMPT_VERSION, type AssessmentDraft, type ExistingVersion} from '../lib/assessments/generate.ts'
import {
  committedPart,
  processLesson,
  type GenerateFn,
  type GenerationRecord,
  type LessonResult,
  type LessonVideo,
  type Mutation,
  type SectionOutcome,
} from '../lib/assessments/pipeline.ts'
import {summarizeCandidates} from '../lib/assessments/quality.ts'
import {parseVideoUrl} from '../lib/video/provider.ts'

/**
 * Offline assessment generation (development plan §5 PR-1). Never runs in the
 * request path.
 *
 *   npm run generate:assessments -- --course <slug>              # one course
 *   npm run generate:assessments -- --lesson <slug>              # one lesson
 *   npm run generate:assessments -- --course <slug> --limit 2    # first 2 lessons
 *   npm run generate:assessments -- --lesson <slug> --dry-run --out candidates.json
 *   npm run generate:assessments -- --lesson <slug> --force      # reprocess recorded sections
 *
 * One model call per bounded transcript section (recall/apply items) plus
 * one transfer call per lesson over one chosen section — never a whole
 * transcript. Candidates are written as Sanity drafts (`drafts.assessment-…`)
 * with review status "needs_review"; nothing is served until an editor
 * approves and publishes it in the Studio. Each processed unit also gets an
 * `assessmentGenerationRecord` in the same transaction, so reruns skip it —
 * including units that produced no candidates — unless `--force`.
 *
 * Regenerating a family replaces its unpublished draft in place (same id);
 * a published version gets a new version instead and is never written.
 * Changed sources mark earlier versions stale. `--force` also deletes the
 * unit's unpublished drafts that the new output does not reproduce.
 * `--dry-run` writes nothing and ignores nothing: it plans exactly like a
 * real run.
 */

const MODEL = 'gpt-5-mini'
/** Question writing benefits from deliberation; latency is irrelevant offline. */
const PROVIDER_OPTIONS = {
  openai: {reasoningEffort: 'medium', reasoningSummary: null} satisfies OpenAILanguageModelResponsesOptions,
}
/** Reasoning tokens count against this budget; truncated output fails validation and is retried next run. */
const MAX_OUTPUT_TOKENS = 6000
/** Offline bound; the request-path default (`AI_GATEWAY_TIMEOUT_MS`) is sized for search. */
const TIMEOUT_MS = 90_000
/** Spend cap per run; remaining sections are reported as deferred. */
const MAX_MODEL_CALLS_PER_RUN = 100
/** Bound on each Sanity request, including reading its body (`AbortSignal.timeout`, Node ≥ 17.3). */
const SANITY_TIMEOUT_MS = 30_000

type Lesson = {_id: string; title: string; slug: string; videoUrl: string | null}
type Outcome = {where: string; status: SectionOutcome['status'] | 'lesson-skipped' | 'lesson-failed'; detail: string}

const {scope, limit, dryRun, force, out} = parseArgs(process.argv.slice(2))

const projectId = requireEnv('NEXT_PUBLIC_SANITY_PROJECT_ID')
const dataset = requireEnv('NEXT_PUBLIC_SANITY_DATASET')
const apiVersion = process.env.NEXT_PUBLIC_SANITY_API_VERSION || '2026-08-31'
const writeToken = process.env.SANITY_API_WRITE_TOKEN
const readToken = writeToken || process.env.SANITY_API_READ_TOKEN
if (!dryRun && !writeToken) {
  console.error('Missing SANITY_API_WRITE_TOKEN (required to write; use --dry-run to generate without writing).')
  process.exit(1)
}
if (!readToken) {
  console.error('Missing SANITY_API_WRITE_TOKEN or SANITY_API_READ_TOKEN (the dataset is private).')
  process.exit(1)
}
requireEnv('OPENAI_API_KEY')

const apiBase = `https://${projectId}.api.sanity.io/v${apiVersion}/data`

const outcomes: Outcome[] = []
const drafts: AssessmentDraft[] = []
const records: GenerationRecord[] = []
const budget = {remaining: MAX_MODEL_CALLS_PER_RUN}
let modelCalls = 0
let markedStale = 0
let replacedDrafts = 0
let deletedDrafts = 0

const generate: GenerateFn = ({kind, system, prompt, schema}) =>
  generateBoundedObject({
    model: openai(MODEL),
    schema,
    system,
    prompt,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    timeoutMs: TIMEOUT_MS,
    providerOptions: PROVIDER_OPTIONS,
    versions: {
      task: kind === 'lesson_transfer' ? 'assessment-transfer' : 'assessment-generation',
      promptVersion: ASSESSMENT_PROMPT_VERSION,
    },
  })

const lessons = await fetchLessons()
const bounded = limit ? lessons.slice(0, limit) : lessons
console.log(`${bounded.length} lesson(s) in scope${dryRun ? ' (dry run)' : ''}${force ? ' (force)' : ''}\n`)

for (const lesson of bounded) {
  try {
    await generateForLesson(lesson)
  } catch (error) {
    outcomes.push({where: lesson.slug, status: 'lesson-failed', detail: error instanceof Error ? error.message : String(error)})
  }
}

if (out) {
  await writeFile(out, `${JSON.stringify({drafts, records}, null, 2)}\n`)
  console.log(`\nWrote ${drafts.length} candidate(s) and ${records.length} section record(s) to ${out}`)
}
report()
process.exit(outcomes.some((outcome) => outcome.status === 'failed' || outcome.status === 'lesson-failed') ? 1 : 0)

async function generateForLesson(lesson: Lesson): Promise<void> {
  const parsed = parseVideoUrl(lesson.videoUrl)
  if (!parsed) {
    outcomes.push({where: lesson.slug, status: 'lesson-skipped', detail: 'no supported video URL'})
    return
  }
  const [video, existing, recordedKeys] = await Promise.all([
    groq<LessonVideo | null>(
      '*[_id == $id][0]{_id, durationSeconds, chapters[]{startSeconds, label}, transcriptChunks[]{_key, startSeconds, text}}',
      {id: parsed.documentId},
      'published',
    ),
    groq<ExistingVersion[] | null>(
      '*[_type == "assessment" && lesson._ref == $lessonId]{_id, familyId, version, sourceStatus, "spanKey": generation.spanKey, sourceChunkRefs[]{chunkId, chunkRevision}}',
      {lessonId: lesson._id},
      'raw',
    ),
    groq<string[] | null>(
      '*[_type == "assessmentGenerationRecord" && lesson._ref == $lessonId].spanKey',
      {lessonId: lesson._id},
      'raw',
    ),
  ])

  const result = await processLesson({
    lesson,
    video,
    existing: existing ?? [],
    processedSpanKeys: new Set(recordedKeys ?? []),
    force,
    model: MODEL,
    generate,
    budget,
  })

  // Each transaction is atomic: a section's drafts and its record land together or not at all.
  // If a later transaction fails, the units already committed are still reported.
  let committed = dryRun ? result.transactions.length : 0
  try {
    if (!dryRun) {
      for (const transaction of result.transactions) {
        await mutate(transaction)
        committed++
      }
    }
  } finally {
    account(lesson, committedPart(result, committed))
  }
}

function account(lesson: Lesson, result: LessonResult): void {
  modelCalls += result.modelCalls
  markedStale += result.staleIds.length
  replacedDrafts += result.replacedIds.length
  deletedDrafts += result.deletedIds.length
  if (result.staleIds.length > 0) {
    console.log(`${lesson.slug}: ${dryRun ? 'would mark' : 'marked'} ${result.staleIds.length} version(s) stale`)
  }
  if (result.skipReason) outcomes.push({where: lesson.slug, status: 'lesson-skipped', detail: result.skipReason})
  for (const section of result.sections) {
    const where = section.kind === 'lesson_transfer' ? `${lesson.slug} transfer(#${section.spanIndex})` : `${lesson.slug} #${section.spanIndex}`
    outcomes.push({where, status: section.status, detail: section.detail})
  }
  drafts.push(...result.drafts)
  records.push(...result.records)
}

async function fetchLessons(): Promise<Lesson[]> {
  const rows =
    scope.kind === 'course'
      ? await groq<Array<Lesson | null> | null>(
          '*[_type == "course" && slug.current == $slug][0].modules[].lessons[]->{_id, title, "slug": slug.current, videoUrl}',
          {slug: scope.slug},
          'published',
        )
      : await groq<Lesson[]>(
          '*[_type == "lesson" && slug.current == $slug]{_id, title, "slug": slug.current, videoUrl}',
          {slug: scope.slug},
          'published',
        )
  const byId = new Map<string, Lesson>()
  for (const row of rows ?? []) if (row?._id && !byId.has(row._id)) byId.set(row._id, row)
  if (byId.size === 0) {
    console.error(`No published lessons found for ${scope.kind} "${scope.slug}".`)
    process.exit(1)
  }
  return [...byId.values()]
}

async function groq<T>(query: string, params: Record<string, unknown>, perspective: 'published' | 'raw'): Promise<T> {
  const search = new URLSearchParams({query, perspective})
  for (const [name, value] of Object.entries(params)) search.set(`$${name}`, JSON.stringify(value))
  const body = (await fetchJson(`${apiBase}/query/${dataset}?${search}`, {headers: authHeaders(readToken)})) as {
    result?: unknown
  }
  return (body.result ?? null) as T
}

async function mutate(mutations: Mutation[]): Promise<void> {
  await fetchJson(`${apiBase}/mutate/${dataset}?returnIds=false`, {
    method: 'POST',
    headers: {...authHeaders(writeToken), 'content-type': 'application/json'},
    body: JSON.stringify({mutations}),
  })
}

function authHeaders(token: string | undefined): Record<string, string> {
  return token ? {authorization: `Bearer ${token}`} : {}
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const method = init?.method ?? 'GET'
  const path = new URL(url).pathname
  let response: Response
  let body: string
  try {
    response = await fetch(url, {...init, signal: AbortSignal.timeout(SANITY_TIMEOUT_MS)})
    body = await response.text()
  } catch (error) {
    if ((error as {name?: unknown})?.name !== 'TimeoutError') throw error
    const mayHaveApplied =
      method === 'POST' ? '; the write may still have applied, and a rerun is safe because recorded units are skipped' : ''
    throw new Error(`${method} ${path} timed out after ${SANITY_TIMEOUT_MS / 1000}s${mayHaveApplied}`)
  }
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${body.slice(0, 200)}`)
  return JSON.parse(body)
}

function parseArgs(argv: string[]): {
  scope: {kind: 'course' | 'lesson'; slug: string}
  limit: number | null
  dryRun: boolean
  force: boolean
  out: string | null
} {
  let scope: {kind: 'course' | 'lesson'; slug: string} | null = null
  let limit: number | null = null
  let dryRun = false
  let force = false
  let out: string | null = null
  const usage =
    'Usage: generate-assessments (--course <slug> | --lesson <slug>) [--limit N] [--dry-run] [--force] [--out file.json]'
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') dryRun = true
    else if (arg === '--force') force = true
    else if ((arg === '--course' || arg === '--lesson') && argv[i + 1] && !scope) {
      scope = {kind: arg === '--course' ? 'course' : 'lesson', slug: argv[++i]}
    } else if (arg === '--limit') {
      const value = Number(argv[++i])
      if (!Number.isInteger(value) || value < 1) {
        console.error('--limit expects a positive integer')
        process.exit(1)
      }
      limit = value
    } else if (arg === '--out' && argv[i + 1]) out = argv[++i]
    else {
      console.error(`Unexpected argument ${arg}. ${usage}`)
      process.exit(1)
    }
  }
  if (!scope) {
    console.error(`A scope is required. ${usage}`)
    process.exit(1)
  }
  return {scope, limit, dryRun, force, out}
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`Missing environment variable ${name} (set it in .env.local).`)
    process.exit(1)
  }
  return value
}

function report(): void {
  console.log('')
  for (const outcome of outcomes) console.log(`${outcome.status.padEnd(15)} ${outcome.where}  ${outcome.detail}`)
  const count = (status: Outcome['status']) => outcomes.filter((outcome) => outcome.status === status).length
  const verb = dryRun ? 'would be' : ''
  console.log(
    `\n${drafts.length} draft(s) ${verb || 'were'} written; sections: ${count('drafted')} drafted, ` +
      `${count('no_candidates')} no candidates, ${count('all_rejected')} all rejected, ${count('skipped')} skipped, ` +
      `${count('deferred')} deferred, ${count('failed')} failed; ${records.length} record(s) ${verb || 'were'} written; ` +
      `${markedStale} version(s) ${dryRun ? 'would be marked' : 'marked'} stale; ` +
      `${replacedDrafts} unpublished draft(s) ${verb || 'were'} replaced, ${deletedDrafts} ${verb || 'were'} deleted; ` +
      `${modelCalls} model call(s)`,
  )
  const summary = summarizeCandidates(drafts, records)
  const counts = (values: Record<string, number>) =>
    Object.entries(values)
      .map(([name, value]) => `${name} ${value}`)
      .join(', ') || 'none'
  console.log(`types: ${counts(summary.byType)}`)
  for (const [optionCount, positions] of Object.entries(summary.correctPosition)) {
    console.log(`correct position (${optionCount} options): ${positions.map((n, i) => `#${i + 1} ${n}`).join(', ')}`)
  }
  console.log(`correct length ÷ longest distractor: ${counts(summary.lengthRatio)}; correct is longest: ${summary.correctIsLongest}`)
  console.log(`rejections: ${counts(summary.rejectionReasons)}`)
  console.log(`rejection details: ${counts(summary.rejectionDetails)}`)
  console.log(`section outcomes: ${counts(summary.outcomes.section)}; transfer outcomes: ${counts(summary.outcomes.lesson_transfer)}`)
}
