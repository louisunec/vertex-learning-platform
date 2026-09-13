/**
 * Live evaluation of the tutor (development plan §5 PR-6 acceptance):
 * `npm run eval:tutor [-- --case <id>]`.
 *
 * Runs retrieval, the model call, and server validation for each case in
 * `scripts/tutor-eval-cases.json` against the published Sanity dataset and
 * OpenAI. Read-only: no database, no writes. Prints each answer with its
 * citations and the cited source text, so a reviewer can check support,
 * not merely clickable links; checks the case's structural expectations
 * (status, scope, cited lessons and times) and exits 1 when any fails.
 *
 * A case is a pilot gate only once a person has reviewed it
 * (`"reviewed": true`); unreviewed cases are reported as such.
 */

import {readFile} from 'node:fs/promises'

import {openai} from '@ai-sdk/openai'
import {z} from 'zod'

import type {AiCallDiagnostics} from '../lib/ai/gateway.ts'
import {contentTerms, generateTutorAnswer, TUTOR_MODEL_ID, type TutorAnswer} from '../lib/ai/tutor.ts'
import {resolveLessonScope, retrieveEvidence} from '../lib/tutor/retrieve.ts'
import {createGroqTutorSource} from '../lib/tutor/source.ts'
import {createSanityHttp, requireEnv} from './sanity-http.mts'

const caseSchema = z.strictObject({
  id: z.string().min(1),
  category: z.enum(['local', 'elsewhere_in_lesson', 'elsewhere_in_course', 'out_of_scope', 'wrong_citation', 'prompt_injection', 'inaccessible']),
  lessonId: z.string().min(1),
  currentSeconds: z.number().int().nonnegative(),
  question: z.string().min(3).max(500),
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(3),
  expect: z.strictObject({
    outcome: z.enum(['answered', 'not_found']).default('answered'),
    status: z.array(z.enum(['supported', 'partial', 'insufficient_evidence'])).optional(),
    scope: z.array(z.enum(['window', 'lesson', 'course'])).optional(),
    /** Every citation must point at one of these lessons. */
    citedLessonIds: z.array(z.string()).optional(),
    /** At least one citation must start inside this range (seconds). */
    citedWithin: z.tuple([z.number(), z.number()]).optional(),
    /** None of these strings may appear in any statement (e.g. leaked instructions). */
    absentText: z.array(z.string()).optional(),
  }),
  notes: z.string(),
  reviewed: z.boolean(),
})

type EvalCase = z.infer<typeof caseSchema>

const casesFile = new URL('./tutor-eval-cases.json', import.meta.url)
const onlyCase = process.argv.includes('--case') ? process.argv[process.argv.indexOf('--case') + 1] : null

requireEnv('OPENAI_API_KEY')
const http = createSanityHttp()
const source = createGroqTutorSource((query, params) => http.groq(query, params, 'published'))
const model = openai(TUTOR_MODEL_ID)

const cases = z.array(caseSchema).parse(JSON.parse(await readFile(casesFile, 'utf8'))).filter((c) => !onlyCase || c.id === onlyCase)

function check(evalCase: EvalCase, answer: TutorAnswer | null, scope: string | null): string[] {
  const {expect} = evalCase
  const failures: string[] = []
  if (!answer) return expect.outcome === 'not_found' ? [] : ['expected an answer, got not_found']
  if (expect.outcome === 'not_found') return ['expected not_found, got an answer']
  if (expect.status && !expect.status.includes(answer.status)) failures.push(`status ${answer.status} not in ${expect.status.join('|')}`)
  if (expect.scope && scope && !expect.scope.includes(scope as never)) failures.push(`scope ${scope} not in ${expect.scope.join('|')}`)
  const citations = answer.statements.flatMap((statement) => statement.citations)
  if (expect.citedLessonIds) {
    const stray = citations.filter((citation) => !expect.citedLessonIds!.includes(citation.lessonId))
    if (stray.length > 0) failures.push(`cites other lessons: ${[...new Set(stray.map((c) => c.lessonId))].join(', ')}`)
  }
  if (expect.citedWithin) {
    const [from, to] = expect.citedWithin
    if (!citations.some((citation) => citation.startSeconds >= from && citation.startSeconds <= to)) {
      failures.push(`no citation starts within ${from}–${to}s`)
    }
  }
  for (const text of expect.absentText ?? []) {
    if (answer.statements.some((statement) => statement.text.toLowerCase().includes(text.toLowerCase()))) failures.push(`statement contains "${text}"`)
  }
  return failures
}

let failed = 0
const usage: AiCallDiagnostics[] = []

for (const evalCase of cases) {
  console.log(`\n━━ ${evalCase.id} (${evalCase.category}, level ${evalCase.level})${evalCase.reviewed ? '' : ' [UNREVIEWED]'}`)
  console.log(`   ${evalCase.lessonId} @ ${evalCase.currentSeconds}s: ${JSON.stringify(evalCase.question)}`)
  const lessonScope = await resolveLessonScope(source, evalCase.lessonId)
  let answer: TutorAnswer | null = null
  let scope: string | null = null
  if (lessonScope) {
    const retrieval = await retrieveEvidence(source, lessonScope, {currentSeconds: evalCase.currentSeconds, terms: contentTerms(evalCase.question)})
    scope = retrieval.scope
    const byId = new Map(retrieval.chunks.map((chunk) => [chunk.chunkId, chunk]))
    answer =
      retrieval.chunks.length === 0
        ? {status: 'insufficient_evidence', statements: [], followUp: null, citedCount: 0}
        : await generateTutorAnswer({
            model,
            level: evalCase.level,
            question: evalCase.question,
            lessonTitle: lessonScope.lesson.title,
            currentSeconds: evalCase.currentSeconds,
            chunks: retrieval.chunks,
            log: (diagnostics) => usage.push(diagnostics),
          })
    console.log(`   → ${answer.status}, scope ${scope}, ${retrieval.chunks.length} sources, ${answer.citedCount} cited`)
    for (const statement of answer.statements) {
      console.log(`   [${statement.kind}] ${statement.text}`)
      for (const citation of statement.citations) {
        console.log(`       ↳ ${citation.label} ${citation.href}: ${JSON.stringify(byId.get(citation.chunkId)?.text.slice(0, 160))}`)
      }
    }
    if (answer.followUp) console.log(`   followUp: ${answer.followUp}`)
  } else {
    console.log('   → not_found (unpublished or inaccessible lesson)')
  }
  const failures = check(evalCase, answer, scope)
  failed += failures.length > 0 ? 1 : 0
  console.log(failures.length > 0 ? `   ✗ ${failures.join('; ')}` : '   ✓ expectations met')
}

const latencies = usage.map((call) => call.latencyMs).toSorted((a, b) => a - b)
const pick = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))]
const tokens = usage.map((call) => call.outputTokens ?? 0)
console.log(
  `\n${cases.length - failed}/${cases.length} cases met their expectations; ${cases.filter((c) => !c.reviewed).length} unreviewed.` +
    (usage.length > 0
      ? ` Model calls: ${usage.length}, failures ${usage.filter((c) => c.status !== 'ok').length}, latency p50 ${pick(0.5)} ms / max ${latencies.at(-1)} ms, output tokens max ${Math.max(...tokens)}.`
      : ''),
)
process.exit(failed > 0 ? 1 : 0)
