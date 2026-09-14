import {randomUUID} from 'node:crypto'
import {writeFile} from 'node:fs/promises'
import {hostname} from 'node:os'
import {parseArgs} from 'node:util'

import {openai, type OpenAILanguageModelResponsesOptions} from '@ai-sdk/openai'
import postgres from 'postgres'

import {generateBoundedObject} from '../lib/ai/gateway.ts'
import {ASSESSMENT_PROMPT_VERSION, type ExistingVersion} from '../lib/assessments/generate.ts'
import type {GenerateFn, LessonVideo, Mutation as PipelineMutation} from '../lib/assessments/pipeline.ts'
import {GENERATION_EXISTING_VERSIONS_QUERY, GENERATION_RECORDED_KEYS_QUERY, GENERATION_VIDEO_QUERY} from '../lib/assessments/sources.ts'
import {finishJobRun, recentJobRuns, startJobRun} from '../lib/db/job-run.ts'
import {SIGNAL_TYPES, type SignalType} from '../lib/signals/config.ts'
import {apiHostFor, createHogQLReader, loadFixtureReader, type EventReader} from '../lib/signals/posthog-reader.ts'
import {claimCandidate, executeCandidate, finishCandidate, listCandidates, REGENERATION_DEFAULTS} from '../lib/signals/regenerate.ts'
import {aggregateSignals} from '../lib/signals/run.ts'
import {createSanitySignalStore, type SignalStore} from '../lib/signals/sanity-store.ts'
import {addSyntheticLearner, listSyntheticLearners, SYNTHETIC_LABELS, type SyntheticLabel} from '../lib/signals/synthetic.ts'
import {DEFAULT_WINDOW_DAYS, windowsToProcess} from '../lib/signals/windows.ts'
import {parseVideoUrl} from '../lib/video/provider.ts'

/**
 * Editorial learning signals (development plan §5 PR-10). Offline tooling,
 * never in the request path; see docs/EDITORIAL_SIGNALS.md.
 *
 *   npm run signals -- aggregate                         # last completed 7-day window + 1 earlier (late events)
 *   npm run signals -- aggregate --include-current       # also the window in progress (marked partial)
 *   npm run signals -- aggregate --as-of 2026-09-14 --window-days 7 --lookback 0
 *   npm run signals -- aggregate --dry-run --out /tmp/signals.json
 *   npm run signals -- aggregate --events fixture.json --dry-run   # fixture events instead of PostHog (labelled fixture)
 *   npm run signals -- aggregate --fixture ...           # label signals as fixture data (never allowed into production)
 *   npm run signals -- aggregate --types assessment_difficulty,tutor_insufficient_evidence
 *   npm run signals -- status                            # recent runs, regeneration queue, synthetic labels
 *   npm run signals -- synthetic add <clerk-user-id> --label demo [--note "demo account"]
 *   npm run signals -- synthetic list
 *   npm run signals -- regenerate                        # list queued draft regeneration candidates
 *   npm run signals -- regenerate --execute [--limit 2]  # needs SIGNALS_REGENERATION_ENABLED=true
 *
 * Postgres types need DATABASE_URL (every query runs as
 * `vertex_signals_worker`). PostHog types need POSTHOG_PERSONAL_API_KEY
 * (`query:read`) and POSTHOG_PROJECT_ID; without them they are skipped and
 * reported, and the Postgres types still run. Writing signals needs
 * SANITY_API_SIGNALS_WRITE_TOKEN; `--dry-run` writes nothing anywhere.
 */

const {positionals, values} = parseArgs({
  allowPositionals: true,
  options: {
    'dry-run': {type: 'boolean', default: false},
    'include-current': {type: 'boolean', default: false},
    'no-regeneration': {type: 'boolean', default: false},
    fixture: {type: 'boolean', default: false},
    'window-days': {type: 'string'},
    lookback: {type: 'string'},
    'as-of': {type: 'string'},
    events: {type: 'string'},
    types: {type: 'string'},
    out: {type: 'string'},
    label: {type: 'string'},
    note: {type: 'string'},
    execute: {type: 'boolean', default: false},
    limit: {type: 'string'},
  },
})

/** Same model settings as `npm run generate:assessments`, so regenerated drafts match the generator's. */
const REGENERATION_MODEL = 'gpt-5-mini'
const REGENERATION_PROVIDER_OPTIONS = {
  openai: {reasoningEffort: 'medium', reasoningSummary: null} satisfies OpenAILanguageModelResponsesOptions,
}

const [command, subcommand, argument] = positionals
const USAGE =
  'Usage: npm run signals -- aggregate [--dry-run] [--events <file>] [--as-of <date>] | status | synthetic add <id> --label <label> | synthetic list | regenerate [--execute]'
if (!['aggregate', 'status', 'synthetic', 'regenerate'].includes(command ?? '')) fail(USAGE)

const url = process.env.DATABASE_URL?.trim()
if (!url) fail('DATABASE_URL is not set (see .env.example).')

const db = postgres(url!, {max: 3, prepare: false, onnotice: () => {}, connection: {application_name: 'vertex-signals'}})
const workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`

try {
  if (command === 'aggregate') await aggregate()
  else if (command === 'status') await status()
  else if (command === 'synthetic') await synthetic()
  else await regenerate()
} catch (error) {
  console.error(`signals ${command} failed:`, error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  await db.end()
}

async function aggregate(): Promise<void> {
  const dryRun = values['dry-run']
  const reader = await eventReader()
  const fixture = values.fixture || reader?.kind === 'fixture'
  const dataset = process.env.NEXT_PUBLIC_SANITY_DATASET ?? ''
  if (fixture && !dryRun && dataset === 'production') {
    fail('Refusing to write fixture signals to the production dataset. Use --dry-run, or point NEXT_PUBLIC_SANITY_DATASET at a test dataset.')
  }
  const store = dryRun ? null : signalStore()
  const now = values['as-of'] ? parseDate(values['as-of']) : new Date()
  const windows = windowsToProcess({
    now,
    days: positiveInt(values['window-days'], DEFAULT_WINDOW_DAYS),
    lookback: nonNegativeInt(values.lookback, 1),
    includeCurrent: values['include-current'],
  })
  const types = values.types ? parseTypes(values.types) : SIGNAL_TYPES

  if (!reader) console.log('PostHog query credentials are not set: replay and search signals are skipped (see docs/EDITORIAL_SIGNALS.md).')
  const reports = await aggregateSignals({
    db,
    reader,
    store,
    windows,
    now,
    workerId,
    types,
    regeneration: values['no-regeneration'] ? false : {},
    fixture,
    recordRun: !dryRun,
  })

  for (const report of reports) {
    console.log(`\nWindow ${report.window.key} [${report.window.start.toISOString()} – ${report.window.end.toISOString()})${report.partial ? ' (partial)' : ''}`)
    for (const [type, entry] of Object.entries(report.types)) {
      const excluded = entry.excluded ? `  excluded ${JSON.stringify(entry.excluded)}` : ''
      console.log(`  ${type.padEnd(28)} ${entry.status.padEnd(7)} subjects=${entry.subjects} raised=${entry.raised}${entry.detail ? ` (${entry.detail})` : ''}${excluded}`)
    }
    for (const entry of report.planned) {
      console.log(`  ${entry.action === 'upsert' ? 'raise  ' : 'refresh'} ${entry.id}  ${entry.fields.title}  ${entry.fields.summary}`)
    }
    for (const entry of report.regeneration) console.log(`  regeneration ${entry.signalId}: ${JSON.stringify(entry.result)}`)
  }
  if (dryRun) console.log('\nDry run: nothing was written to Sanity, the regeneration queue, or the job log.')
  if (values.out) {
    await writeFile(values.out, `${JSON.stringify(reports.map((report) => ({...report, planned: report.planned.map((entry) => ({id: entry.id, ...entry.fields}))})), null, 2)}\n`)
    console.log(`Wrote ${values.out}`)
  }
}

async function status(): Promise<void> {
  const [runs, regenerationRuns, candidates, labels] = await Promise.all([
    recentJobRuns(db, 'signal_aggregation', 10),
    recentJobRuns(db, 'regeneration', 5),
    listCandidates(db, {limit: 20}),
    listSyntheticLearners(db),
  ])
  console.log('Recent aggregation runs:')
  for (const run of runs) {
    console.log(`  ${run.startedAt.toISOString()}  ${run.status.padEnd(9)}  window ${run.windowStart?.toISOString() ?? '-'}  ${run.error ?? ''}`)
    for (const [type, counts] of Object.entries(run.counts)) if (typeof counts === 'object') console.log(`      ${type}: ${JSON.stringify(counts)}`)
  }
  if (runs.length === 0) console.log('  (none)')
  console.log('\nRegeneration queue (latest):')
  for (const candidate of candidates) {
    console.log(`  ${candidate.queuedDay}  ${candidate.status.padEnd(8)}  ${candidate.assessmentId}  attempts=${candidate.attempts}  ${candidate.lastError ?? ''}`)
  }
  if (candidates.length === 0) console.log('  (empty)')
  for (const run of regenerationRuns) console.log(`  run ${run.startedAt.toISOString()} ${run.status} ${JSON.stringify(run.counts)}`)
  console.log(`\nSynthetic learners excluded: ${labels.length}`)
}

async function synthetic(): Promise<void> {
  if (subcommand === 'list') {
    for (const row of await listSyntheticLearners(db)) console.log(`${row.learnerId}  ${row.label}  ${row.note ?? ''}`)
    return
  }
  if (subcommand !== 'add' || !argument) fail(USAGE)
  const label = values.label as SyntheticLabel | undefined
  if (!label || !SYNTHETIC_LABELS.includes(label)) fail(`--label must be one of ${SYNTHETIC_LABELS.join(', ')}`)
  const added = await addSyntheticLearner(db, {learnerId: argument!, label: label!, note: values.note ?? null})
  console.log(added ? `Labelled ${argument} as ${label}: excluded from aggregates and analytics delivery.` : `${argument} was already labelled.`)
}

async function regenerate(): Promise<void> {
  if (!values.execute) {
    const candidates = (await listCandidates(db)).filter((candidate) => candidate.status === 'queued' || candidate.status === 'running')
    console.log(`${candidates.length} queued draft regeneration candidate(s):`)
    for (const candidate of candidates) console.log(`  ${candidate.queuedDay}  ${candidate.assessmentId}  lesson ${candidate.lessonId}  signal ${candidate.signalId}`)
    console.log('\nExecution is off by default: set SIGNALS_REGENERATION_ENABLED=true and pass --execute.')
    return
  }
  if (process.env.SIGNALS_REGENERATION_ENABLED !== 'true') fail('Regeneration is disabled: set SIGNALS_REGENERATION_ENABLED=true to execute.')
  const writeToken = process.env.SANITY_API_WRITE_TOKEN
  if (!writeToken) fail('SANITY_API_WRITE_TOKEN (the offline generator credential) is required to write drafts.')
  if (!process.env.OPENAI_API_KEY) fail('OPENAI_API_KEY is required to generate drafts.')

  const sanity = sanityHttp(writeToken!)
  const store = signalStore()
  const generate: GenerateFn = ({kind, system, prompt, schema}) =>
    generateBoundedObject({
      model: openai(REGENERATION_MODEL),
      schema,
      system,
      prompt,
      maxOutputTokens: 6000,
      timeoutMs: 90_000,
      providerOptions: REGENERATION_PROVIDER_OPTIONS,
      versions: {task: kind === 'lesson_transfer' ? 'assessment-transfer' : 'assessment-generation', promptVersion: ASSESSMENT_PROMPT_VERSION},
    })

  const runId = await startJobRun(db, 'regeneration', workerId)
  const counts = {drafted: 0, skipped: 0, failed: 0}
  try {
    for (let index = 0; index < positiveInt(values.limit, REGENERATION_DEFAULTS.perRun); index++) {
      const candidate = await claimCandidate(db, workerId)
      if (!candidate) break
      try {
        const outcome = await executeCandidate(candidate, {
          model: REGENERATION_MODEL,
          generate,
          commit: (transaction: PipelineMutation[]) => sanity.mutate(transaction),
          async loadInputs(lessonId) {
            const lesson = await sanity.groq<{_id: string; title: string; videoUrl: string | null} | null>(
              '*[_type == "lesson" && _id == $id][0]{_id, title, videoUrl}',
              {id: lessonId},
              'published',
            )
            const parsed = parseVideoUrl(lesson?.videoUrl)
            if (!lesson || !parsed) return null
            const [video, existing, recordedKeys] = await Promise.all([
              sanity.groq<LessonVideo | null>(GENERATION_VIDEO_QUERY, {id: parsed.documentId}, 'published'),
              sanity.groq<ExistingVersion[] | null>(GENERATION_EXISTING_VERSIONS_QUERY, {lessonId}, 'raw'),
              sanity.groq<string[] | null>(GENERATION_RECORDED_KEYS_QUERY, {lessonId}, 'raw'),
            ])
            return {lesson: {_id: lesson._id, title: lesson.title}, video, existing: existing ?? [], recordedKeys: recordedKeys ?? []}
          },
        })
        counts[outcome.status]++
        await finishCandidate(db, workerId, candidate.id, {
          status: outcome.status,
          result: {draftIds: outcome.draftIds, modelCalls: outcome.modelCalls, reason: outcome.reason},
          error: outcome.status === 'failed' ? outcome.reason : null,
        })
        await store.setRegeneration(candidate.signalId, {
          status: outcome.status,
          candidateId: candidate.id,
          queuedDay: candidate.queuedDay,
          draftIds: outcome.draftIds,
          ...(outcome.reason ? {detail: outcome.reason.slice(0, 200)} : {}),
        })
        console.log(`${candidate.assessmentId}: ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ''}${outcome.draftIds.length ? ` → ${outcome.draftIds.join(', ')}` : ''}`)
      } catch (error) {
        counts.failed++
        const message = error instanceof Error ? error.message : String(error)
        // A failure before any write returns the candidate to the queue until its attempts run out.
        await finishCandidate(db, workerId, candidate.id, {status: candidate.attempts >= REGENERATION_DEFAULTS.maxAttempts ? 'failed' : 'queued', error: message})
        console.error(`${candidate.assessmentId}: failed (${message})`)
      }
    }
    await finishJobRun(db, runId, {status: counts.failed > 0 ? 'failed' : 'succeeded', counts})
  } catch (error) {
    await finishJobRun(db, runId, {status: 'failed', counts, error: (error as Error).message}).catch(() => undefined)
    throw error
  }
  console.log(JSON.stringify(counts))
  console.log('Drafts await review in Studio → Assessments → Needs review. Nothing was published.')
}

async function eventReader(): Promise<EventReader | null> {
  if (values.events) return loadFixtureReader(values.events)
  const key = process.env.POSTHOG_PERSONAL_API_KEY?.trim()
  const projectId = process.env.POSTHOG_PROJECT_ID?.trim()
  if (!key || !projectId) return null
  const apiHost = process.env.POSTHOG_API_HOST?.trim() || apiHostFor(process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim() ?? '')
  if (!/^https:\/\//.test(apiHost)) fail('Set POSTHOG_API_HOST (for example https://us.posthog.com).')
  return createHogQLReader({apiHost, projectId, personalApiKey: key})
}

function sanityConfig() {
  const projectId = process.env.NEXT_PUBLIC_SANITY_PROJECT_ID
  const dataset = process.env.NEXT_PUBLIC_SANITY_DATASET
  if (!projectId || !dataset) fail('NEXT_PUBLIC_SANITY_PROJECT_ID and NEXT_PUBLIC_SANITY_DATASET are required.')
  return {projectId: projectId!, dataset: dataset!, apiVersion: process.env.NEXT_PUBLIC_SANITY_API_VERSION || '2026-08-31'}
}

function signalStore(): SignalStore {
  const token = process.env.SANITY_API_SIGNALS_WRITE_TOKEN?.trim()
  if (!token) fail('SANITY_API_SIGNALS_WRITE_TOKEN is required to write signals (or pass --dry-run).')
  return createSanitySignalStore({...sanityConfig(), token: token!})
}

function sanityHttp(token: string) {
  const {projectId, dataset, apiVersion} = sanityConfig()
  const base = `https://${projectId}.api.sanity.io/v${apiVersion}/data`
  const request = async (target: string, init?: RequestInit) => {
    const response = await fetch(target, {
      ...init,
      headers: {authorization: `Bearer ${token}`, ...init?.headers},
      signal: AbortSignal.timeout(30_000),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`Sanity request failed: HTTP ${response.status} ${text.slice(0, 200)}`)
    return text ? JSON.parse(text) : null
  }
  return {
    async groq<T>(query: string, params: Record<string, unknown>, perspective: 'raw' | 'published'): Promise<T> {
      const search = new URLSearchParams({query, perspective})
      for (const [name, value] of Object.entries(params)) search.set(`$${name}`, JSON.stringify(value))
      return ((await request(`${base}/query/${dataset}?${search}`)) as {result?: T}).result as T
    },
    async mutate(mutations: unknown[]): Promise<void> {
      await request(`${base}/mutate/${dataset}?returnIds=false`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({mutations}),
      })
    },
  }
}

function parseTypes(value: string): SignalType[] {
  const types = value.split(',').map((type) => type.trim())
  for (const type of types) if (!(SIGNAL_TYPES as readonly string[]).includes(type)) fail(`Unknown signal type "${type}". Use ${SIGNAL_TYPES.join(', ')}.`)
  return types as SignalType[]
}

function parseDate(value: string): Date {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) fail(`Invalid date "${value}".`)
  return date
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) fail(`Expected a positive whole number, got "${value}".`)
  return parsed
}

function nonNegativeInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) fail(`Expected a whole number, got "${value}".`)
  return parsed
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}
