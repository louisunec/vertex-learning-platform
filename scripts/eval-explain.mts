import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {existsSync} from 'node:fs'
import {mkdir, readFile, writeFile} from 'node:fs/promises'

import {openai} from '@ai-sdk/openai'
import {z} from 'zod'

import {
  EXPLAIN_MODEL_ID,
  EXPLAIN_PROMPT_VERSION,
  EXPLAIN_VALIDATOR_VERSION,
  runExplanationFeedback,
  validateExplanation,
  type ExplainCall,
} from '../lib/ai/explain.ts'
import type {AiCallDiagnostics} from '../lib/ai/gateway.ts'
import {checkExpectations, checkStructure, copiesPoint, explainEvalCaseSchema, type ExplainEvalCase} from '../lib/explain/eval-check.ts'
import {createGroqExplanationTaskSource, LESSON_EXPLANATION_TASK_QUERY} from '../lib/explain/source.ts'
import type {ExplainTask} from '../lib/explain/task.ts'
import {normalizeExplanation} from '../lib/explain/text.ts'
import {formatClock} from '../lib/format.ts'
import {createSanityHttp, requireEnv} from './sanity-http.mts'

/**
 * Live evaluation of explain-back feedback (development plan §5 PR-8):
 *
 *   npm run eval:explain [-- --draft <file.ndjson>] [--cases <file.json>] [--case <id>[,<id>…]] [--report <file.md>]
 *   npm run eval:explain -- --replay docs/evals/local/<run>.json [--report <file.md>]
 *
 * `--replay` re-applies the current server gates and checks to a saved
 * run's raw model output, with no model call: how a gate change alters the
 * same outputs, separate from the model's run-to-run variation.
 *
 * Builds the pilot task from the editor draft (default
 * `docs/explain-back/local/sessions-vs-jwt-revocation.draft.ndjson`), as if
 * it were published. The draft and its cases live in the gitignored
 * `docs/explain-back/local/`: the private points state the answers, and so
 * do accurate synthetic explanations. Its chunks
 * and concepts are read from the published dataset through the production
 * source (`lib/explain/source.ts`), so a changed transcript fails here the
 * way it would hide the task. A case may swap one criterion's sources for an
 * eval-only variant. It then makes one model call per step of each synthetic
 * case in the cases file (default
 * `docs/explain-back/local/sessions-vs-jwt-revocation.cases.json`).
 *
 * Read-only: no database, no Sanity writes. Structural checks and the
 * expectations written before any run are reported separately
 * (`lib/explain/eval-check.ts`); neither is a person's reading. The report
 * quotes no transcript text: model feedback that copies a run of transcript
 * words is redacted there, and the full run, including the raw model
 * output and removed model text, goes to the gitignored `docs/evals/local/`.
 * The report quotes the synthetic explanations and the model's feedback, so
 * it belongs in a local directory too. Exits 1 when a structural check fails.
 */

const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null)
const onlyCases = arg('--case')?.split(',').filter(Boolean) ?? null
const reportFile = arg('--report')
const replayFile = arg('--replay')
const DRAFT = arg('--draft') ?? 'docs/explain-back/local/sessions-vs-jwt-revocation.draft.ndjson'
const CASES = arg('--cases') ?? 'docs/explain-back/local/sessions-vs-jwt-revocation.cases.json'
for (const file of [DRAFT, CASES]) {
  if (!existsSync(file)) {
    console.error(`${file} not found. Real tasks and their cases are kept out of git: see docs/explain-back/README.md.`)
    process.exit(1)
  }
}

if (!replayFile) requireEnv('OPENAI_API_KEY')
const http = createSanityHttp()

type SavedRun = {commit: string; prompt: string; validator: string; model: string; results: Array<{id: string; task: ExplainTask; steps: Array<{text: string; run: ExplainCall | null}>}>}
const replayed = replayFile ? (JSON.parse(await readFile(replayFile, 'utf8')) as SavedRun) : null
if (replayed && replayed.prompt !== EXPLAIN_PROMPT_VERSION) throw new Error(`${replayFile} used prompt ${replayed.prompt}; a replay needs the same prompt (${EXPLAIN_PROMPT_VERSION}).`)

type DraftCriterion = {_key: string; label: string; point: string; required: boolean; objectiveKey?: string; sourceChunkIds: string[]; concept: {_ref: string}}
type DraftRef = {chunkId: string; chunkRevision: string; startSeconds: number; endSeconds: number}
type Draft = {_id: string; lesson: {_ref: string}; criteria: DraftCriterion[]; sourceChunkRefs: DraftRef[]} & Record<string, unknown>

const draft = JSON.parse((await readFile(DRAFT, 'utf8')).trim()) as Draft

/** The draft as the published task query would return it, optionally with one criterion's sources swapped. */
async function taskFor(variant: ExplainEvalCase['variant']): Promise<ExplainTask> {
  const sourcesOf = (criterion: DraftCriterion) => (variant?.criterionId === criterion._key ? variant.sourceChunkRefs.map((ref) => ref.chunkId) : criterion.sourceChunkIds)
  // A variant keeps only the chunks its criteria still cite, so the task stays within its source bound.
  const cited = new Set(draft.criteria.flatMap(sourcesOf))
  const refs = [...draft.sourceChunkRefs, ...(variant?.sourceChunkRefs ?? [])].filter(
    (ref, index, all) => cited.has(ref.chunkId) && all.findIndex((other) => other.chunkId === ref.chunkId) === index,
  )
  const source = createGroqExplanationTaskSource(async (query, params) => {
    if (query !== LESSON_EXPLANATION_TASK_QUERY) return http.groq(query, params, 'published')
    const lesson = await http.groq('*[_type == "lesson" && _id == $id][0]{_id, title, "slug": slug.current, videoUrl}', {id: draft.lesson._ref}, 'published')
    const concepts = await http.groq<Array<Record<string, unknown>>>(
      '*[_id in $ids]{_id, conceptId, name, reviewStatus, "objectiveKeys": objectives[]._key}',
      {ids: [...new Set(draft.criteria.map((criterion) => criterion.concept._ref))]},
      'published',
    )
    return {
      ...draft,
      _id: draft._id.replace(/^drafts\./, ''),
      criteria: draft.criteria.map((criterion) => ({
        id: criterion._key,
        label: criterion.label,
        point: criterion.point,
        required: criterion.required,
        objectiveKey: criterion.objectiveKey ?? null,
        sourceChunkIds: sourcesOf(criterion),
        concept: concepts.find((concept) => concept._id === criterion.concept._ref) ?? null,
      })),
      sourceChunkRefs: refs,
      lesson,
    }
  })
  const loaded = await source.loadLessonTask(draft.lesson._ref)
  if (loaded.status !== 'ok') throw new Error(`The draft task did not resolve (${loaded.status}): re-run npm run draft:explanation-task.`)
  return loaded.task
}

const caseText = await readFile(CASES, 'utf8')
const cases = z
  .array(explainEvalCaseSchema)
  .parse(JSON.parse(caseText))
  .filter((entry) => !onlyCases || onlyCases.includes(entry.id))
if (onlyCases && cases.length !== onlyCases.length) throw new Error(`Unknown case in --case: ${onlyCases.join(', ')}`)
const model = openai(EXPLAIN_MODEL_ID)

const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim()
const dirty = execFileSync('git', ['status', '--porcelain']).toString().trim().length > 0
const casesHash = createHash('sha256').update(caseText).digest('hex').slice(0, 12)

type StepResult = {text: string; run: ExplainCall | null; error: string | null; structural: string[]; semantic: string[]; calls: AiCallDiagnostics[]}
type CaseResult = {id: string; description: string; variant: boolean; task: ExplainTask; steps: StepResult[]}
const results: CaseResult[] = []

for (const entry of cases) {
  const saved = replayed?.results.find((result) => result.id === entry.id)
  if (replayed && !saved) throw new Error(`${entry.id} is not in ${replayFile}`)
  const task = saved ? saved.task : await taskFor(entry.variant)
  const steps: StepResult[] = []
  for (const [index, step] of entry.steps.entries()) {
    const normalized = normalizeExplanation(step.text)
    if (!normalized.ok) throw new Error(`${entry.id}: ${normalized.problem}`)
    const calls: AiCallDiagnostics[] = []
    try {
      const savedStep = saved?.steps[index]
      if (saved && (savedStep?.text !== normalized.text || !savedStep.run?.output)) throw new Error(`${entry.id} step ${index + 1}: no saved raw output for this text`)
      const run = savedStep?.run?.output
        ? {...validateExplanation(savedStep.run.output, task, normalized.text), output: savedStep.run.output}
        : await runExplanationFeedback({model, task, text: normalized.text, log: (diagnostics) => calls.push(diagnostics)})
      steps.push({
        text: normalized.text,
        run,
        error: null,
        structural: checkStructure(run.analysis, task, normalized.text),
        semantic: checkExpectations(run.analysis, step.expect),
        calls,
      })
    } catch (error) {
      steps.push({text: normalized.text, run: null, error: error instanceof Error ? error.message : String(error), structural: ['model call failed'], semantic: ['model call failed'], calls})
    }
    const last = steps.at(-1)!
    const statuses = last.run?.analysis.criteria.map((criterion) => `${criterion.criterionId}=${criterion.status}`).join(' ') ?? last.error
    console.log(
      `${last.structural.length === 0 ? 'S-ok ' : 'S-FAIL'} ${last.semantic.length === 0 ? 'E-ok ' : 'E-FAIL'} ${entry.id}${entry.steps.length > 1 ? ` step ${steps.length}` : ''}: ${last.run?.analysis.outcome ?? ''} ${statuses}` +
        `${[...last.structural, ...last.semantic].length ? ` — ${[...last.structural, ...last.semantic].join('; ')}` : ''}`,
    )
  }
  results.push({id: entry.id, description: entry.description, variant: Boolean(entry.variant), task, steps})
}

const stepsRun = results.flatMap((result) => result.steps)
const structural = stepsRun.filter((step) => step.structural.length === 0).length
const semantic = stepsRun.filter((step) => step.semantic.length === 0).length
const calls = stepsRun.flatMap((step) => step.calls)
const latencies = calls.map((call) => call.latencyMs).toSorted((a, b) => a - b)
const quantile = (q: number) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] : 0)
const failedCalls = calls.filter((call) => call.status !== 'ok')
console.log(`\nStructural: ${structural}/${stepsRun.length} steps. Expectations: ${semantic}/${stepsRun.length} steps. Calls: ${calls.length} (${failedCalls.length} failed); latency p50 ${(quantile(0.5) / 1000).toFixed(1)} s, max ${((latencies.at(-1) ?? 0) / 1000).toFixed(1)} s.`)

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
await mkdir('docs/evals/local', {recursive: true})
await writeFile(
  `docs/evals/local/pr-8-explain-${stamp}.json`,
  JSON.stringify({commit, dirty, casesHash, replayOf: replayFile, prompt: EXPLAIN_PROMPT_VERSION, validator: EXPLAIN_VALIDATOR_VERSION, model: EXPLAIN_MODEL_ID, results}, null, 2),
)

if (reportFile) await writeFile(reportFile, renderReport())
process.exit(structural === stepsRun.length ? 0 : 1)

/** Model text that copies a run of transcript words is not reproduced in the public report. */
function publicText(text: string, task: ExplainTask): string {
  return task.evidence.some((chunk) => copiesPoint(text, chunk.text)) ? '[redacted here: copies transcript wording; full text in docs/evals/local/]' : text
}

function renderReport(): string {
  const lines = [
    '# PR-8 explain-back: live evaluation',
    '',
    `- Code: \`${commit}\`${dirty ? ' plus uncommitted changes' : ''}; prompt \`${EXPLAIN_PROMPT_VERSION}\`, gates \`${EXPLAIN_VALIDATOR_VERSION}\`; model \`${EXPLAIN_MODEL_ID}\` (low reasoning effort); one call per step, no verifier model.`,
    ...(replayed ? [`- **Replay, no model calls:** the raw outputs of \`${replayFile}\` (gates \`${replayed.validator}\`, code \`${replayed.commit}\`) through the current gates.`] : []),
    `- Cases: \`${CASES}\` (sha256 \`${casesHash}\`), expectations written before the first run. The explanations are synthetic.`,
    `- Task: the unpublished editor draft on the published lesson; transcript chunks and concepts resolved live at their reviewed revisions.`,
    `- **Structural checks: ${structural}/${stepsRun.length} steps pass** (a status for every point, spans inside the text, citations only from that point's sources, no internal ids or copied rubric text, one clean follow-up).`,
    `- **Expectations: ${semantic}/${stepsRun.length} steps pass** (the acceptable statuses fixed per case). Neither check is a person's reading of the feedback.`,
    `- Calls: ${calls.length}, ${failedCalls.length} failed${failedCalls.length ? ` (${failedCalls.map((call) => call.status).join(', ')})` : ''}; latency p50 ${(quantile(0.5) / 1000).toFixed(1)} s, p90 ${(quantile(0.9) / 1000).toFixed(1)} s, max ${((latencies.at(-1) ?? 0) / 1000).toFixed(1)} s; tokens in/out ${sum(calls.map((call) => call.inputTokens))}/${sum(calls.map((call) => call.outputTokens))}.`,
    '- No transcript text appears here. Citations show the lesson time and chunk id only.',
    '',
  ]
  for (const result of results) {
    lines.push(`## ${result.id}${result.variant ? ' (eval-only task variant)' : ''}`, '', result.description, '')
    result.steps.forEach((step, index) => {
      if (result.steps.length > 1) lines.push(`### Step ${index + 1}`, '')
      lines.push(`> ${step.text.replace(/\n/g, ' ')}`, '')
      lines.push(`Structural: **${step.structural.length === 0 ? 'pass' : `fail: ${step.structural.join('; ')}`}**. Expectations: **${step.semantic.length === 0 ? 'pass' : `fail: ${step.semantic.join('; ')}`}**.`, '')
      const timing = step.calls.map((call) => `${call.status} ${(call.latencyMs / 1000).toFixed(1)} s, ${call.inputTokens ?? '?'}→${call.outputTokens ?? '?'} tokens`).join('; ')
      if (timing) lines.push(`Call: ${timing}`, '')
      if (!step.run) {
        lines.push(`Error: ${step.error}`, '')
        return
      }
      const {analysis} = step.run
      lines.push(`Outcome: \`${analysis.outcome}\``, '')
      if (analysis.criteria.length > 0) {
        lines.push('| Point | Status | Learner words | Feedback | Lesson moments |', '| --- | --- | --- | --- | --- |')
        for (const criterion of analysis.criteria) {
          const words = criterion.span ? `“${step.text.slice(criterion.span.start, criterion.span.end)}”` : '—'
          const cites = criterion.citations.map((citation) => `${formatClock(citation.startSeconds)} \`${citation.chunkId.split(':').at(-1)}\``).join(', ') || '—'
          const cell = (value: string) => value.replace(/\|/g, '\\|').replace(/\n/g, ' ')
          lines.push(`| \`${criterion.criterionId}\`${criterion.required ? '' : ' (optional)'} | ${criterion.status} | ${cell(words)} | ${cell(criterion.feedback ? publicText(criterion.feedback, result.task) : '—')} | ${cites} |`)
        }
        lines.push('')
      }
      lines.push(`Follow-up: ${analysis.followUpQuestion ? publicText(analysis.followUpQuestion, result.task) : '—'}`, '')
      if (step.run.droppedOutput.length > 0) {
        lines.push(`Changed by the server gates: ${step.run.droppedOutput.map((entry) => `${entry.reason}${entry.criterionId ? ` (\`${entry.criterionId}\`)` : ''}`).join(', ')}`, '')
      }
    })
  }
  return `${lines.join('\n')}\n`
}

function sum(values: Array<number | null>): number | string {
  return values.every((value) => value !== null) ? values.reduce<number>((total, value) => total + (value ?? 0), 0) : '?'
}
