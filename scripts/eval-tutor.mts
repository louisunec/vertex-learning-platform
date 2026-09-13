/**
 * Live evaluation of the tutor (development plan §5 PR-6 acceptance):
 *
 *   npm run eval:tutor [-- --case <id>] [--terms model|deterministic|both] [--runs <n>]
 *                      [--packet <file.md>] [--json <file.json>]
 *
 * Runs retrieval, the model calls, and server validation for each case in
 * `scripts/tutor-eval-cases.json` against the published Sanity dataset and
 * OpenAI. Read-only: no database, no writes. Prints each answer with its
 * citations and the cited source text, so a reviewer can check support,
 * not merely clickable links; checks the case's structural expectations
 * (`lib/tutor/eval-check.ts`) and exits 1 when any fails. Statements shown
 * passed the deterministic gates and the model support check, neither of
 * which is proof of support.
 *
 * `--terms` picks how retrieval terms are made: `deterministic` (the
 * learner's words and the fixed word list, as the service does) or `model`
 * (plus the `tutor-terms-v1` call); `both` runs the two arms interleaved by
 * case, `--runs` times each, and reports latency by stage per arm.
 * `--packet` writes the human review packet from the last run of one arm.
 *
 * A case is a pilot gate only once a person has reviewed it
 * (`"reviewed": true`); unreviewed cases are reported as such.
 */

import {readFile, writeFile} from 'node:fs/promises'

import {openai} from '@ai-sdk/openai'
import {z} from 'zod'

import {AiCallError, type AiCallDiagnostics} from '../lib/ai/gateway.ts'
import {answerTutorQuestion, TUTOR_MODEL_ID, TUTOR_PROMPT_VERSION, type EvidenceChunk, type TutorAnswer} from '../lib/ai/tutor.ts'
import {TUTOR_SUPPORT_PROMPT_VERSION} from '../lib/ai/tutor-support.ts'
import {expandTutorTerms} from '../lib/ai/tutor-terms.ts'
import {formatClock} from '../lib/format.ts'
import {checkCase, evalCaseSchema, inKeyPassage, type EvalCase} from '../lib/tutor/eval-check.ts'
import {resolveLessonScope, retrieveEvidence} from '../lib/tutor/retrieve.ts'
import {createGroqTutorSource} from '../lib/tutor/source.ts'
import {deterministicTerms} from '../lib/tutor/terms.ts'
import {createSanityHttp, requireEnv} from './sanity-http.mts'

type Arm = 'model' | 'deterministic'
const STAGES = ['lesson', 'terms', 'retrieval', 'answer', 'support', 'total'] as const
type Stage = (typeof STAGES)[number]

const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null)
const onlyCase = arg('--case')
const termsArg = arg('--terms') ?? 'deterministic'
if (!['model', 'deterministic', 'both'].includes(termsArg)) throw new Error(`--terms must be model, deterministic, or both`)
const arms: Arm[] = termsArg === 'both' ? ['model', 'deterministic'] : [termsArg as Arm]
const runs = Number(arg('--runs') ?? 1)
if (!Number.isInteger(runs) || runs < 1 || runs > 5) throw new Error('--runs must be 1–5')
const packetFile = arg('--packet')
if (packetFile && arms.length > 1) throw new Error('--packet needs a single --terms arm')
const jsonFile = arg('--json')

requireEnv('OPENAI_API_KEY')
const http = createSanityHttp()
const source = createGroqTutorSource((query, params) => http.groq(query, params, 'published'))
const model = openai(TUTOR_MODEL_ID)

const casesFile = new URL('./tutor-eval-cases.json', import.meta.url)
const cases = z.array(evalCaseSchema).parse(JSON.parse(await readFile(casesFile, 'utf8'))).filter((c) => !onlyCase || c.id === onlyCase)

type Result = {
  caseId: string
  arm: Arm
  run: number
  terms: string[]
  scope: string | null
  evidence: EvidenceChunk[]
  answer: TutorAnswer | null
  error: string | null
  failures: string[]
  keyRetrieved: boolean | null
  keyCited: boolean | null
  stages: Partial<Record<Stage, number>>
}

const results: Result[] = []

async function runCase(evalCase: EvalCase, arm: Arm, run: number): Promise<Result> {
  const stages: Result['stages'] = {}
  const started = performance.now()
  const timed = async <T,>(stage: Stage, work: () => Promise<T> | T): Promise<T> => {
    const t0 = performance.now()
    try {
      return await work()
    } finally {
      stages[stage] = Math.round(performance.now() - t0)
    }
  }
  const result: Result = {caseId: evalCase.id, arm, run, terms: [], scope: null, evidence: [], answer: null, error: null, failures: [], keyRetrieved: null, keyCited: null, stages}
  const lessonScope = await timed('lesson', () => resolveLessonScope(source, evalCase.lessonId))
  if (lessonScope) {
    // The same pipeline as `askTutor`, without the database.
    const {baseTerms, terms: listed} = deterministicTerms(evalCase.question)
    const terms = await timed('terms', () =>
      arm === 'model' ? expandTutorTerms({model, question: evalCase.question, baseTerms, log: () => {}}) : listed,
    )
    const retrieval = await timed('retrieval', () => retrieveEvidence(source, lessonScope, {currentSeconds: evalCase.currentSeconds, terms, baseTerms}))
    Object.assign(result, {terms, scope: retrieval.scope, evidence: retrieval.chunks})
    const calls: AiCallDiagnostics[] = []
    try {
      result.answer =
        retrieval.chunks.length === 0
          ? {status: 'insufficient_evidence', statements: [], followUp: null, citedCount: 0, dropped: []}
          : await answerTutorQuestion({
              model,
              level: evalCase.level,
              question: evalCase.question,
              terms,
              lessonTitle: lessonScope.lesson.title,
              currentSeconds: evalCase.currentSeconds,
              chunks: retrieval.chunks,
              log: (diagnostics) => calls.push(diagnostics),
            })
    } catch (error) {
      // The route would answer 503 (retryable): a failed case, never a pass.
      if (!(error instanceof AiCallError)) throw error
      result.error = error.category
    }
    const latency = (task: string) => calls.filter((call) => call.task === task).reduce((sum, call) => sum + call.latencyMs, 0)
    if (calls.some((call) => call.task === 'tutor-answer')) stages.answer = latency('tutor-answer')
    if (calls.some((call) => call.task === 'tutor-support')) stages.support = latency('tutor-support')
    if (evalCase.key) {
      result.keyRetrieved = retrieval.chunks.some((chunk) => inKeyPassage(evalCase, chunk))
      result.keyCited = (result.answer?.statements ?? []).some((statement) => statement.citations.some((citation) => inKeyPassage(evalCase, citation)))
    }
  }
  stages.total = Math.round(performance.now() - started)
  result.failures = result.error ? [`model call failed (${result.error}); the route would return a retryable 503`] : checkCase(evalCase, result.answer, result.scope)
  return result
}

function print(evalCase: EvalCase, result: Result) {
  const clock = (chunkId: string) => {
    const chunk = result.evidence.find((candidate) => candidate.chunkId === chunkId)
    return chunk ? `${chunk.lessonTitle} · ${formatClock(chunk.startSeconds)}` : chunkId
  }
  console.log(`\n━━ ${evalCase.id} [${result.arm} terms, run ${result.run}] (${evalCase.category}, level ${evalCase.level})${evalCase.reviewed ? '' : ' [UNREVIEWED]'}`)
  console.log(`   ${evalCase.lessonId} @ ${evalCase.currentSeconds}s: ${JSON.stringify(evalCase.question)}`)
  if (result.scope === null) console.log('   → not_found (unpublished or inaccessible lesson)')
  else {
    console.log(`   terms: ${result.terms.join(', ') || '(none)'}`)
    const answer = result.answer
    if (answer) {
      console.log(`   → ${answer.status}, scope ${result.scope}, ${result.evidence.length} sources, ${answer.citedCount} cited, ${answer.dropped.length} dropped`)
      for (const statement of answer.statements) {
        console.log(`   [${statement.kind}]${statement.citations.length > 0 ? ' (gates + support check passed)' : ''} ${statement.text}`)
        for (const citation of statement.citations) {
          const text = result.evidence.find((chunk) => chunk.chunkId === citation.chunkId)?.text
          console.log(`       ↳ ${citation.label} ${citation.href}: ${JSON.stringify(text?.slice(0, 160))}`)
        }
      }
      for (const dropped of answer.dropped) {
        const where = dropped.uncitedChunkId ? ` [wording at ${clock(dropped.uncitedChunkId)}]` : ''
        console.log(`   ✂ dropped ${dropped.kind} (${dropped.reason})${where}: ${dropped.text}`)
      }
      if (answer.followUp) console.log(`   followUp: ${answer.followUp}`)
    }
    if (evalCase.key) console.log(`   key passage: retrieved ${result.keyRetrieved ? 'yes' : 'no'}, cited ${result.keyCited ? 'yes' : 'no'}`)
  }
  console.log(`   stages (ms): ${STAGES.filter((stage) => result.stages[stage] !== undefined).map((stage) => `${stage} ${result.stages[stage]}`).join(', ')}`)
  console.log(result.failures.length > 0 ? `   ✗ ${result.failures.join('; ')}` : '   ✓ expectations met')
}

for (let run = 1; run <= runs; run++) {
  for (const evalCase of cases) {
    for (const arm of arms) {
      const result = await runCase(evalCase, arm, run)
      results.push(result)
      print(evalCase, result)
    }
  }
}

const percentile = (values: number[], p: number) => {
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

console.log(`\n# ${TUTOR_PROMPT_VERSION}, ${TUTOR_SUPPORT_PROMPT_VERSION}, ${TUTOR_MODEL_ID}; ${cases.length} cases × ${runs} run(s); ${cases.filter((c) => !c.reviewed).length} unreviewed`)
for (const arm of arms) {
  const own = results.filter((result) => result.arm === arm)
  const passed = own.filter((result) => result.failures.length === 0).length
  const withKey = own.filter((result) => result.keyRetrieved !== null)
  const dropped = own.flatMap((result) => result.answer?.dropped ?? [])
  const reasons = [...new Set(dropped.map((drop) => drop.reason))].map((reason) => `${reason} ${dropped.filter((drop) => drop.reason === reason).length}`)
  const kept = own.reduce((sum, result) => sum + (result.answer?.statements.filter((statement) => statement.kind === 'claim').length ?? 0), 0)
  const abstained = own.filter((result) => result.answer?.status === 'insufficient_evidence').map((result) => result.caseId)
  console.log(`\n[${arm} terms] ${passed}/${own.length} met their structural expectations`)
  console.log(`  key passage retrieved ${withKey.filter((r) => r.keyRetrieved).length}/${withKey.length}, cited ${withKey.filter((r) => r.keyCited).length}/${withKey.length}`)
  console.log(`  claims kept ${kept}; dropped ${dropped.length}${reasons.length > 0 ? ` (${reasons.join(', ')})` : ''}; model failures ${own.filter((r) => r.error).length}`)
  console.log(`  abstained (insufficient_evidence): ${abstained.join(', ') || 'none'}`)
  for (const stage of STAGES) {
    const values = own.map((result) => result.stages[stage]).filter((value): value is number => value !== undefined)
    if (values.length > 0) console.log(`  ${stage.padEnd(9)} p50 ${String(percentile(values, 0.5)).padStart(6)} ms   max ${String(Math.max(...values)).padStart(6)} ms   (n=${values.length})`)
  }
}

if (jsonFile) {
  await writeFile(jsonFile, JSON.stringify(results.map(({evidence, ...rest}) => ({...rest, evidenceStarts: evidence.map((chunk) => `${chunk.lessonId}@${chunk.startSeconds}`)})), null, 2))
}

if (packetFile) await writeFile(packetFile, reviewPacket(results.filter((result) => result.run === runs)))

/** The human review packet: every answer with its claims, cited timestamps, and full quoted source text. */
function reviewPacket(last: Result[]): string {
  const lines = [
    '# PR-6 tutor: human review packet',
    '',
    `Generated by \`npm run eval:tutor -- --terms ${arms[0]} --packet …\` on ${new Date().toISOString().slice(0, 16)}Z against the published Sanity dataset (read-only) and OpenAI \`${TUTOR_MODEL_ID}\`; prompts \`${TUTOR_PROMPT_VERSION}\` and \`${TUTOR_SUPPORT_PROMPT_VERSION}\`.`,
    '',
    '**Review status: pending.** Every case stays `"reviewed": false` in `scripts/tutor-eval-cases.json` until you change it. What you see passed the server gates (valid refs, a shared term, no wording from an uncited source) and the model support check; none of these is proof that a claim is supported. Please judge each claim against the quoted source text alone.',
    '',
    'The help level is set by each case; the help policy is not exercised here. Timestamps link to the lesson page at that second.',
    '',
    'For each claim, mark one: `supported` · `not supported` · `wrong source`. For each case, mark whether the answer is acceptable.',
  ]
  for (const evalCase of cases) {
    const result = last.find((candidate) => candidate.caseId === evalCase.id)
    if (!result) continue
    lines.push('', '---', '', `## ${evalCase.id}`, '')
    lines.push(`- **Question:** ${evalCase.question}`)
    lines.push(`- **Lesson / playhead:** \`${evalCase.lessonId}\` at ${formatClock(evalCase.currentSeconds)}`)
    lines.push(`- **Help level:** ${evalCase.level} (set by the case)`)
    if (result.scope === null) {
      lines.push('- **Outcome:** not found (unpublished or inaccessible lesson); no retrieval or model call.')
    } else if (result.error || !result.answer) {
      lines.push(`- **Outcome:** model call failed (${result.error}); the route would return a retryable 503.`)
    } else {
      const answer = result.answer
      lines.push(`- **Status / scope:** ${answer.status} / ${result.scope} (${result.evidence.length} sources retrieved, ${answer.citedCount} cited)`)
      lines.push(`- **What to check:** ${evalCase.notes}`)
      lines.push('')
      if (answer.statements.length === 0) lines.push('_No statements: the tutor said it could not find enough supporting material._')
      answer.statements.forEach((statement, i) => {
        lines.push(`${i + 1}. **[${statement.kind}]** ${statement.text}`)
        for (const citation of statement.citations) {
          const text = result.evidence.find((chunk) => chunk.chunkId === citation.chunkId)?.text ?? '(source text unavailable)'
          lines.push(`   - [${citation.label}](${citation.href}) (${formatClock(citation.startSeconds)}–${formatClock(citation.endSeconds)}):`)
          lines.push(`     > ${text}`)
        }
        if (statement.citations.length > 0) lines.push('   - Verdict: ☐ supported ☐ not supported ☐ wrong source')
      })
      if (answer.followUp) lines.push('', `_Follow-up suggestion:_ ${answer.followUp}`)
      if (answer.dropped.length > 0) {
        lines.push('', 'Removed by the server before display:')
        for (const dropped of answer.dropped) {
          const chunk = dropped.uncitedChunkId ? result.evidence.find((candidate) => candidate.chunkId === dropped.uncitedChunkId) : null
          lines.push(`- ${dropped.kind}, \`${dropped.reason}\`${chunk ? ` (its wording is at ${formatClock(chunk.startSeconds)})` : ''}: ${dropped.text}`)
        }
      }
    }
    lines.push('', '**Answer acceptable?** ☐ yes ☐ no — notes:')
  }
  return `${lines.join('\n')}\n`
}

process.exit(results.some((result) => result.failures.length > 0) ? 1 : 0)
