/**
 * The tutor's human review packet (PR-6), from live evaluation results.
 *
 *   node --env-file-if-exists=.env.local scripts/tutor-packet.mts <manifest.json>
 *
 * The manifest names the output files, one or more sections (a title, a note,
 * and a results file written by `npm run eval:tutor -- --json`), and optional
 * connective verdicts. Source text is re-read by chunk id from the published
 * Sanity dataset (read-only); the results files hold no transcript text.
 *
 * Transcripts are third-party and not cleared for redistribution, so the
 * committed packet quotes at most one excerpt of `EXCERPT_WORDS` words per
 * statement (the window sharing most words with it) and links every cited
 * timestamp; the full-text copy goes to `fullOut`, under the gitignored
 * `docs/evals/local/`, for local review only.
 */

import {readFile, writeFile, mkdir} from 'node:fs/promises'
import {dirname} from 'node:path'
import {fileURLToPath} from 'node:url'

import {z} from 'zod'

import type {TutorAnswer} from '../lib/ai/tutor.ts'
import {formatClock} from '../lib/format.ts'
import {STOPWORDS, tokenize} from '../lib/search/terms.ts'
import type {EvalCase} from '../lib/tutor/eval-check.ts'

export const EXCERPT_WORDS = 25

export type PacketResult = {caseId: string; scope: string | null; error: string | null; answer: TutorAnswer | null; evidenceCount: number}
export type PacketSection = {title: string; note: string; results: PacketResult[]}
/** A connective checked after the run (the support check's connective rule), keyed by case id and text. */
export type ConnectiveVerdict = {caseId: string; text: string; verdict: 'supported' | 'not_supported'}

/** The run of `EXCERPT_WORDS` words of `text` sharing the most topic words with `statement`. */
export function excerpt(text: string, statement: string): string {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length <= EXCERPT_WORDS) return words.join(' ')
  const topic = new Set(tokenize(statement).filter((token) => token.length >= 4 && !STOPWORDS.has(token)))
  const hits = words.map((word) => (tokenize(word).some((token) => topic.has(token)) ? 1 : 0))
  let best = 0
  let bestScore = -1
  for (let start = 0; start + EXCERPT_WORDS <= words.length; start++) {
    const score = hits.slice(start, start + EXCERPT_WORDS).reduce((sum: number, hit) => sum + hit, 0)
    if (score > bestScore) [best, bestScore] = [start, score]
  }
  const window = words.slice(best, best + EXCERPT_WORDS).join(' ')
  return `${best > 0 ? '…' : ''}${window}${best + EXCERPT_WORDS < words.length ? '…' : ''}`
}

const startOf = (chunkId: string) => Number(/:tc-(\d+)/.exec(chunkId)?.[1] ?? Number.NaN)

export function renderPacket({
  heading,
  cases,
  sections,
  textOf,
  full,
  connectiveVerdicts = [],
}: {
  heading: string[]
  cases: readonly EvalCase[]
  sections: readonly PacketSection[]
  textOf: (chunkId: string) => string | undefined
  /** Quote every cited chunk in full (local copy) instead of one short excerpt per statement. */
  full: boolean
  connectiveVerdicts?: readonly ConnectiveVerdict[]
}): string {
  const lines = [
    '# PR-6 tutor: human review packet',
    '',
    ...heading,
    '',
    '**Review status: pending.** Every case stays `"reviewed": false` in `scripts/tutor-eval-cases.json` until you change it. What you see passed the server gates and the model support check. Gate 2b (no wording from an uncited source) is a lexical heuristic, and neither it nor the model check is proof that a claim is supported. Judge each claim against the source at its timestamps.',
    '',
    full
      ? 'Local copy: every cited chunk is quoted in full. Do not commit or share it (third-party transcripts, redistribution not confirmed).'
      : `Each statement quotes at most one excerpt of ${EXCERPT_WORDS} words from its cited chunks (third-party transcripts, redistribution not confirmed); follow the timestamp links for the rest, or regenerate the full local copy under \`docs/evals/local/\`.`,
    '',
    'The help level is set by each case; the help policy is not exercised here. For each cited statement, mark one: `supported` · `not supported` · `wrong source`. For each connective, mark whether it states a fact the cited text does not. For each case, mark whether the answer is acceptable.',
  ]
  for (const section of sections) {
    lines.push('', '---', '', `# ${section.title}`, '', section.note)
    for (const evalCase of cases) {
      const result = section.results.find((candidate) => candidate.caseId === evalCase.id)
      if (!result) continue
      lines.push('', `## ${evalCase.id}`, '')
      lines.push(`- **Question:** ${evalCase.question}`)
      lines.push(`- **Lesson / playhead:** \`${evalCase.lessonId}\` at ${formatClock(evalCase.currentSeconds)}`)
      lines.push(`- **Help level:** ${evalCase.level} (set by the case)`)
      if (result.scope === null) {
        lines.push('- **Outcome:** not found (unpublished or inaccessible lesson); no retrieval or model call.')
      } else if (result.error || !result.answer) {
        lines.push(`- **Outcome:** model call failed (${result.error}); the route would return a retryable 503.`)
      } else {
        const answer = result.answer
        lines.push(`- **Status / scope:** ${answer.status} / ${result.scope} (${result.evidenceCount} sources retrieved, ${answer.citedCount} cited)`)
        lines.push(`- **What to check:** ${evalCase.notes}`)
        lines.push('')
        if (answer.statements.length === 0) lines.push('_No statements: the tutor said it could not find enough supporting material._')
        answer.statements.forEach((statement, i) => {
          lines.push(`${i + 1}. **[${statement.kind}]** ${statement.text}`)
          if (statement.citations.length > 0) {
            lines.push(`   - Cited: ${statement.citations.map((citation) => `[${formatClock(citation.startSeconds)}](${citation.href})`).join(' · ')} (${statement.citations[0].label.split(' · ')[0]})`)
            if (full) {
              for (const citation of statement.citations) lines.push(`     > ${formatClock(citation.startSeconds)}: ${textOf(citation.chunkId) ?? '(source text unavailable)'}`)
            } else {
              const joined = statement.citations.map((citation) => textOf(citation.chunkId) ?? '').join(' ')
              if (joined.trim()) lines.push(`     > ${excerpt(joined, statement.text)}`)
            }
            lines.push('   - Verdict: ☐ supported ☐ not supported ☐ wrong source')
          } else if (statement.kind === 'connective') {
            const verdict = connectiveVerdicts.find((candidate) => candidate.caseId === evalCase.id && candidate.text === statement.text)
            if (verdict) lines.push(`   - Connective check (run afterwards on this stored answer): ${verdict.verdict === 'supported' ? 'passed' : 'failed; the current tutor would drop it'}`)
            lines.push('   - States a fact the cited text does not? ☐ no ☐ yes')
          }
        })
        if (answer.followUp) lines.push('', `_Follow-up suggestion:_ ${answer.followUp}`)
        if (answer.dropped.length > 0) {
          lines.push('', 'Removed by the server before display:')
          for (const dropped of answer.dropped) {
            const where = dropped.uncitedChunkId ? ` (lexical heuristic: its wording is at ${formatClock(startOf(dropped.uncitedChunkId))})` : ''
            // A dropped pointer's text is its chunk id: show where it pointed.
            const text = dropped.kind === 'pointer' ? `pointer to ${formatClock(startOf(dropped.text))}` : dropped.text
            lines.push(`- ${dropped.kind}, \`${dropped.reason}\`${where}: ${text}`)
          }
        }
      }
      lines.push('', '**Answer acceptable?** ☐ yes ☐ no — notes:')
    }
  }
  return `${lines.join('\n')}\n`
}

const manifestSchema = z.object({
  out: z.string(),
  fullOut: z.string().startsWith('docs/evals/local/'),
  heading: z.array(z.string()),
  sections: z.array(z.object({title: z.string(), note: z.string(), results: z.array(z.string()).min(1)})).min(1),
  connectiveVerdicts: z.string().optional(),
})

async function main(manifestPath: string) {
  const {createSanityHttp} = await import('./sanity-http.mts')
  const {evalCaseSchema} = await import('../lib/tutor/eval-check.ts')
  const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')))
  const cases = z.array(evalCaseSchema).parse(JSON.parse(await readFile(new URL('./tutor-eval-cases.json', import.meta.url), 'utf8')))
  const sections: PacketSection[] = []
  for (const section of manifest.sections) {
    const results: PacketResult[] = []
    for (const file of section.results) {
      for (const row of JSON.parse(await readFile(file, 'utf8')) as Array<PacketResult & {evidenceStarts?: string[]}>) {
        results.push({caseId: row.caseId, scope: row.scope, error: row.error, answer: row.answer, evidenceCount: row.evidenceStarts?.length ?? 0})
      }
    }
    sections.push({title: section.title, note: section.note, results})
  }
  const chunkIds = new Set(
    sections.flatMap((section) => section.results.flatMap((result) => (result.answer?.statements ?? []).flatMap((statement) => statement.citations.map((citation) => citation.chunkId)))),
  )
  const videoIds = [...new Set([...chunkIds].map((id) => id.slice(0, id.lastIndexOf(':'))))]
  const http = createSanityHttp()
  const rows = (await http.groq(`*[_type == "video" && _id in $videoIds]{_id, "chunks": transcriptChunks[]{_key, text}}`, {videoIds}, 'published')) as Array<{_id: string; chunks: Array<{_key: string; text: string}>}>
  const texts = new Map<string, string>(rows.flatMap((row) => row.chunks.map((chunk) => [`${row._id}:${chunk._key}`, chunk.text] as const)))
  const connectiveVerdicts = manifest.connectiveVerdicts ? (JSON.parse(await readFile(manifest.connectiveVerdicts, 'utf8')) as ConnectiveVerdict[]) : []
  const render = (full: boolean) => renderPacket({heading: manifest.heading, cases, sections, textOf: (id) => texts.get(id), full, connectiveVerdicts})
  await writeFile(manifest.out, render(false))
  await mkdir(dirname(manifest.fullOut), {recursive: true})
  await writeFile(manifest.fullOut, render(true))
  console.log(`wrote ${manifest.out} and ${manifest.fullOut} (${chunkIds.size} cited chunks)`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv[2] ?? '')
