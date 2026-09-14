import {execFileSync} from 'node:child_process'
import {mkdir, readFile, writeFile} from 'node:fs/promises'

import {openai} from '@ai-sdk/openai'
import {z} from 'zod'

import type {AiCallDiagnostics} from '../lib/ai/gateway.ts'
import {REVIEW_CHECK_PROMPT_VERSION} from '../lib/ai/review-check.ts'
import {REVIEW_MODEL_ID, REVIEW_PROMPT_VERSION, runSubmissionReview, type ReviewRun} from '../lib/ai/review.ts'
import {formatClock} from '../lib/format.ts'
import {checkReviewStep, reviewEvalCaseSchema} from '../lib/submissions/eval-check.ts'
import {createGroqSubmissionTaskSource, LESSON_TASK_QUERY} from '../lib/submissions/source.ts'
import type {SubmissionTask} from '../lib/submissions/task.ts'
import {normalizeSubmission} from '../lib/submissions/text.ts'
import {createSanityHttp, requireEnv} from './sanity-http.mts'

/**
 * Live evaluation of submission review (development plan §5 PR-12):
 *
 *   npm run eval:review [-- --case <id>[,<id>…]] [--report <file.md>]
 *
 * Builds the pilot task from the editor draft
 * (`docs/submission-review/*.draft.ndjson`), as if it were published. Its
 * chunks are read from the published dataset through the production source
 * (`lib/submissions/source.ts`), so a changed transcript fails here the way
 * it would hide the task. It then runs both model calls on each synthetic
 * case in `scripts/review-eval-cases.json`.
 *
 * Read-only: no database, no Sanity writes. Structural checks
 * (`lib/submissions/eval-check.ts`) are reported separately from the
 * feedback text, which needs a person's reading. The report quotes no
 * transcript text, because transcripts are third-party. The full run,
 * including dropped model output, goes to the gitignored `docs/evals/local/`.
 * Exits 1 when a structural check fails.
 */

const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null)
const onlyCases = arg('--case')?.split(',').filter(Boolean) ?? null
const reportFile = arg('--report')
const DRAFT = 'docs/submission-review/sql-injection-user-lookup.draft.ndjson'

requireEnv('OPENAI_API_KEY')
const http = createSanityHttp()

const draft = JSON.parse((await readFile(DRAFT, 'utf8')).trim()) as {
  _id: string
  lesson: {_ref: string}
  criteria: Array<{_key: string; text: string}>
  concepts: Array<{_ref: string}>
  sourceChunkRefs: Array<{chunkId: string; chunkRevision: string; startSeconds: number; endSeconds: number}>
} & Record<string, unknown>

// The draft stands in for the published task; everything else is live and published.
const source = createGroqSubmissionTaskSource(async (query, params) => {
  if (query !== LESSON_TASK_QUERY) return http.groq(query, params, 'published')
  const lesson = await http.groq<{_id: string; title: string; slug: string; videoUrl: string | null} | null>(
    '*[_type == "lesson" && _id == $id][0]{_id, title, "slug": slug.current, videoUrl}',
    {id: draft.lesson._ref},
    'published',
  )
  return {
    ...draft,
    _id: draft._id.replace(/^drafts\./, ''),
    criteria: draft.criteria.map((criterion) => ({id: criterion._key, text: criterion.text})),
    concepts: [],
    lesson,
  }
})
const loaded = await source.loadLessonTask(draft.lesson._ref)
if (loaded.status !== 'ok') {
  console.error(`The draft task did not resolve (${loaded.status}): re-run npm run draft:submission-task.`)
  process.exit(1)
}
const task: SubmissionTask = loaded.task

const cases = z
  .array(reviewEvalCaseSchema)
  .parse(JSON.parse(await readFile('scripts/review-eval-cases.json', 'utf8')))
  .filter((entry) => !onlyCases || onlyCases.includes(entry.id))
if (onlyCases && cases.length !== onlyCases.length) throw new Error(`Unknown case in --case: ${onlyCases.join(', ')}`)
const model = openai(REVIEW_MODEL_ID)

const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim()
const dirty = execFileSync('git', ['status', '--porcelain']).toString().trim().length > 0

type StepResult = {code: string; run: ReviewRun | null; error: string | null; failures: string[]; calls: AiCallDiagnostics[]}
const results: Array<{id: string; kind: string; description: string; reviewed: boolean; steps: StepResult[]}> = []

for (const entry of cases) {
  const steps: StepResult[] = []
  for (const step of entry.steps) {
    const normalized = normalizeSubmission(step.code)
    if (!normalized.ok) throw new Error(`${entry.id}: ${normalized.problem}`)
    const calls: AiCallDiagnostics[] = []
    try {
      const run = await runSubmissionReview({model, task, submission: normalized.value, log: (diagnostics) => calls.push(diagnostics)})
      steps.push({code: normalized.value.content, run, error: null, failures: checkReviewStep(run.analysis, step.expect), calls})
    } catch (error) {
      steps.push({code: normalized.value.content, run: null, error: error instanceof Error ? error.message : String(error), failures: ['model call failed'], calls})
    }
    const last = steps.at(-1)!
    console.log(`${last.failures.length === 0 ? 'PASS' : 'FAIL'} ${entry.id}${entry.steps.length > 1 ? ` step ${steps.length}` : ''}: ${last.run?.analysis.outcome ?? last.error}${last.failures.length ? ` — ${last.failures.join('; ')}` : ''}`)
  }
  results.push({id: entry.id, kind: entry.kind, description: entry.description, reviewed: entry.reviewed, steps})
}

const stepsRun = results.flatMap((result) => result.steps)
const passed = stepsRun.filter((step) => step.failures.length === 0).length
console.log(`\nStructural: ${passed}/${stepsRun.length} steps pass. ${results.filter((result) => result.reviewed).length}/${results.length} cases human-reviewed.`)

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
await mkdir('docs/evals/local', {recursive: true})
await writeFile(`docs/evals/local/pr-12-review-${stamp}.json`, JSON.stringify({commit, dirty, task: task.taskId, taskHash: task.taskHash, results}, null, 2))

if (reportFile) await writeFile(reportFile, renderReport())
process.exit(passed === stepsRun.length ? 0 : 1)

function renderReport(): string {
  const criterion = new Map(task.criteria.map((entry) => [entry.id, entry.text]))
  const lines = [
    '# PR-12 submission review: live evaluation',
    '',
    `- Code: \`${commit}\`${dirty ? ' plus uncommitted changes' : ''}; prompts \`${REVIEW_PROMPT_VERSION}\` / \`${REVIEW_CHECK_PROMPT_VERSION}\`; model \`${REVIEW_MODEL_ID}\` (low reasoning effort).`,
    `- Task: the unpublished editor draft \`${task.taskId}\` v${task.version} on the published lesson "${task.lesson.title}" (${task.evidence.length} transcript chunks resolved live, revisions matched). The submissions are synthetic.`,
    `- **Structural checks: ${passed}/${stepsRun.length} steps pass.** These check shape (outcome, where problems are, what is not flagged) and, for the driver regressions, text the corrections must or must not contain. They say nothing about whether the wording is right.`,
    `- **Semantic review: ${results.filter((result) => result.reviewed).length}/${results.length} cases read by a person.** Until then, no case is a pilot gate.`,
    '- No transcript text appears here. Citations show the lesson time and chunk id only.',
    '',
  ]
  for (const result of results) {
    lines.push(`## ${result.id} (${result.kind})`, '', result.description, '')
    result.steps.forEach((step, index) => {
      if (result.steps.length > 1) lines.push(`### Step ${index + 1}`, '')
      lines.push('```js', step.code, '```', '')
      lines.push(`Structural: **${step.failures.length === 0 ? 'pass' : `fail: ${step.failures.join('; ')}`}**`, '')
      const timing = step.calls.map((call) => `${call.task} ${call.status} ${(call.latencyMs / 1000).toFixed(1)} s, ${call.inputTokens ?? '?'}→${call.outputTokens ?? '?'} tokens`).join('; ')
      if (timing) lines.push(`Calls: ${timing}`, '')
      if (!step.run) {
        lines.push(`Error: ${step.error}`, '')
        return
      }
      const {analysis} = step.run
      lines.push(`Outcome: \`${analysis.outcome}\`${analysis.cannotJudgeReason ? ` (${analysis.cannotJudgeReason})` : ''}`, '')
      if (analysis.criteria.length > 0) {
        lines.push('| Criterion | Status |', '| --- | --- |')
        for (const entry of analysis.criteria) lines.push(`| ${criterion.get(entry.criterionId)} | ${entry.status} |`)
        lines.push('')
      }
      for (const finding of analysis.findings) {
        const cites = finding.citations.map((citation) => `${formatClock(citation.startSeconds)} (\`${citation.chunkId.split(':').at(-1)}\`)`).join(', ')
        lines.push(
          `- **${finding.category}**, lines ${finding.startLine}–${finding.endLine}${finding.criterionId ? `, criterion \`${finding.criterionId}\`` : ''}${cites ? `; cites ${cites}` : '; no course citation'}`,
          ...(finding.question ? [`  - L1 question: ${finding.question}`] : []),
          `  - L2 explanation: ${finding.explanation}`,
          ...(finding.correction ? [`  - L3 correction: ${finding.correction.replace(/\n/g, ' ⏎ ')}`] : []),
        )
      }
      if (analysis.findings.length === 0) lines.push('- No findings.')
      if (step.run.droppedOutput.length > 0) lines.push('', `Removed or replaced by the server: ${step.run.droppedOutput.map((entry) => `${entry.reason}${entry.category ? ` (${entry.category})` : ''}`).join(', ')}`)
      lines.push('')
    })
  }
  return `${lines.join('\n')}\n`
}
