/**
 * Live evaluation of the tutor (development plan §5 PR-6 acceptance):
 * `npm run eval:tutor [-- --case <id>]`.
 *
 * Runs retrieval, the model call, and server validation for each case in
 * `scripts/tutor-eval-cases.json` against the published Sanity dataset and
 * OpenAI. Read-only: no database, no writes. Prints each answer with its
 * citations and the cited source text, so a reviewer can check support,
 * not merely clickable links; checks the case's structural expectations
 * (`lib/tutor/eval-check.ts`) and exits 1 when any fails. Statements shown
 * passed the model support check, which is not proof of support.
 *
 * A case is a pilot gate only once a person has reviewed it
 * (`"reviewed": true`); unreviewed cases are reported as such.
 */

import {readFile} from 'node:fs/promises'

import {openai} from '@ai-sdk/openai'
import {z} from 'zod'

import {AiCallError, type AiCallDiagnostics} from '../lib/ai/gateway.ts'
import {answerTutorQuestion, contentTerms, TUTOR_MODEL_ID, type TutorAnswer} from '../lib/ai/tutor.ts'
import {expandTutorTerms} from '../lib/ai/tutor-terms.ts'
import {checkCase, evalCaseSchema} from '../lib/tutor/eval-check.ts'
import {resolveLessonScope, retrieveEvidence} from '../lib/tutor/retrieve.ts'
import {createGroqTutorSource} from '../lib/tutor/source.ts'
import {createSanityHttp, requireEnv} from './sanity-http.mts'

const casesFile = new URL('./tutor-eval-cases.json', import.meta.url)
const onlyCase = process.argv.includes('--case') ? process.argv[process.argv.indexOf('--case') + 1] : null

requireEnv('OPENAI_API_KEY')
const http = createSanityHttp()
const source = createGroqTutorSource((query, params) => http.groq(query, params, 'published'))
const model = openai(TUTOR_MODEL_ID)

const cases = z.array(evalCaseSchema).parse(JSON.parse(await readFile(casesFile, 'utf8'))).filter((c) => !onlyCase || c.id === onlyCase)

let failed = 0
const usage: AiCallDiagnostics[] = []

for (const evalCase of cases) {
  console.log(`\n━━ ${evalCase.id} (${evalCase.category}, level ${evalCase.level})${evalCase.reviewed ? '' : ' [UNREVIEWED]'}`)
  console.log(`   ${evalCase.lessonId} @ ${evalCase.currentSeconds}s: ${JSON.stringify(evalCase.question)}`)
  const lessonScope = await resolveLessonScope(source, evalCase.lessonId)
  let answer: TutorAnswer | null = null
  let scope: string | null = null
  if (lessonScope) {
    // The same pipeline as `askTutor`, without the database.
    const baseTerms = contentTerms(evalCase.question)
    const terms = await expandTutorTerms({model, question: evalCase.question, baseTerms, log: (d) => usage.push(d)})
    const retrieval = await retrieveEvidence(source, lessonScope, {currentSeconds: evalCase.currentSeconds, terms, baseTerms})
    scope = retrieval.scope
    const byId = new Map(retrieval.chunks.map((chunk) => [chunk.chunkId, chunk]))
    let result: TutorAnswer
    try {
      result =
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
              log: (d) => usage.push(d),
            })
    } catch (error) {
      // The route would answer 503 (retryable): a failed case, never a pass.
      if (!(error instanceof AiCallError)) throw error
      console.log(`   ✗ model call failed (${error.category}); the route would return a retryable 503`)
      failed++
      continue
    }
    answer = result
    console.log(`   terms: ${terms.join(', ') || '(none)'}`)
    console.log(`   → ${result.status}, scope ${scope}, ${retrieval.chunks.length} sources, ${result.citedCount} cited, ${result.dropped.length} dropped`)
    for (const statement of result.statements) {
      const verdict = statement.citations.length > 0 ? ' (support check: supported)' : ''
      console.log(`   [${statement.kind}]${verdict} ${statement.text}`)
      for (const citation of statement.citations) {
        console.log(`       ↳ ${citation.label} ${citation.href}: ${JSON.stringify(byId.get(citation.chunkId)?.text.slice(0, 160))}`)
      }
    }
    for (const dropped of result.dropped) console.log(`   ✂ dropped ${dropped.kind} (${dropped.reason}): ${dropped.text}`)
    if (result.followUp) console.log(`   followUp: ${result.followUp}`)
  } else {
    console.log('   → not_found (unpublished or inaccessible lesson)')
  }
  const failures = checkCase(evalCase, answer, scope)
  failed += failures.length > 0 ? 1 : 0
  console.log(failures.length > 0 ? `   ✗ ${failures.join('; ')}` : '   ✓ expectations met')
}

console.log(`\n${cases.length - failed}/${cases.length} cases met their structural expectations; ${cases.filter((c) => !c.reviewed).length} unreviewed.`)
for (const task of [...new Set(usage.map((call) => call.task))]) {
  const calls = usage.filter((call) => call.task === task)
  const latencies = calls.map((call) => call.latencyMs).toSorted((a, b) => a - b)
  console.log(
    `  ${task}: ${calls.length} calls, ${calls.filter((c) => c.status !== 'ok').length} failed, ` +
      `latency p50 ${latencies[Math.floor(latencies.length / 2)]} ms / max ${latencies.at(-1)} ms, ` +
      `output tokens max ${Math.max(...calls.map((c) => c.outputTokens ?? 0))}`,
  )
}
process.exit(failed > 0 ? 1 : 0)
