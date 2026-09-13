/**
 * The tutor's human review packet (PR-6), from live evaluation results.
 *
 *   node --env-file-if-exists=.env.local scripts/tutor-packet.mts <manifest.json>
 *
 * The manifest names the output files and one or more sections. A section
 * lists results files written by `npm run eval:tutor -- --json`, each with
 * its provenance: the code commit and prompt versions that produced it, and
 * whether it is a fresh run or a stored older result shown again. Stored
 * results are replayed offline (no model call) through the current
 * deterministic gates 2c and 2d, and the packet says what those would drop.
 *
 * Transcripts are third-party and not cleared for redistribution, so the
 * committed packet carries no source text: statements, timestamp links, and
 * summaries only. Source text is re-read by chunk id from the published
 * Sanity dataset (read-only) for the full copy at `fullOut`, under the
 * gitignored `docs/evals/local/`, for private review only.
 */

import {readFile, writeFile, mkdir} from 'node:fs/promises'
import {dirname} from 'node:path'
import {fileURLToPath} from 'node:url'

import {z} from 'zod'

import {findConnectiveAddition, findUnsupportedContrast, type TutorAnswer} from '../lib/ai/tutor.ts'
import {formatClock} from '../lib/format.ts'
import type {EvalCase} from '../lib/tutor/eval-check.ts'

const provenanceSchema = z.object({
  kind: z.enum(['fresh', 'stored']),
  /** The run's name in the packet ("run 4", "targeted check"). */
  run: z.string(),
  commit: z.string().regex(/^[0-9a-f]{7,40}$/),
  date: z.string(),
  promptVersion: z.string(),
  supportPromptVersion: z.string(),
})
export type Provenance = z.infer<typeof provenanceSchema>

export type PacketResult = {caseId: string; scope: string | null; error: string | null; answer: TutorAnswer | null; evidenceCount: number; provenance: Provenance}
/** `review`: verdict boxes for the reviewer; otherwise the answers are shown for reference only. */
export type PacketSection = {title: string; note: string; review: boolean; results: PacketResult[]}
/** A connective checked after the run (the support check's connective rule), keyed by case id and text. */
export type ConnectiveVerdict = {caseId: string; text: string; verdict: 'supported' | 'not_supported'}

const startOf = (chunkId: string) => Number(/:tc-(\d+)/.exec(chunkId)?.[1] ?? Number.NaN)

export function provenanceLine({kind, run, commit, date, promptVersion, supportPromptVersion}: Provenance): string {
  const code = `\`${commit}\` (\`${promptVersion}\` / \`${supportPromptVersion}\`)`
  return kind === 'fresh' ? `**Fresh run** at ${code}, ${date}.` : `**Stored result** from ${run} at ${code}, ${date}; not re-run.`
}

/**
 * What the current gates 2c and 2d would remove from a stored answer, from
 * its cited text; null when the cited text is unavailable.
 */
export function replayCurrentGates(answer: TutorAnswer, question: string, level: number, textOf: (chunkId: string) => string | undefined): string[] | null {
  const claims = answer.statements.flatMap((statement, i) => (statement.kind === 'claim' ? [{statement, n: i + 1}] : []))
  const cited = claims.map(({statement}) => statement.citations.map((citation) => textOf(citation.chunkId)))
  if (cited.some((texts) => texts.some((text) => text === undefined))) return null
  const removed: string[] = []
  const kept: Array<{text: string; sources: string[]}> = []
  claims.forEach(({statement, n}, i) => {
    const sources = cited[i] as string[]
    const contrast = findUnsupportedContrast(statement.text, sources, question)
    if (contrast) removed.push(`statement ${n} (claim; contrast "${contrast}" is not in its cited text)`)
    else kept.push({text: statement.text, sources})
  })
  // At level 1 the only connective is the guiding question, which gate 2d does not see.
  if (level > 1) {
    answer.statements.forEach((statement, i) => {
      if (statement.kind !== 'connective') return
      const added = findConnectiveAddition(statement.text, kept.map((claim) => claim.text), kept.flatMap((claim) => claim.sources), question)
      if (added) removed.push(`statement ${i + 1} (connective; adds "${added}")`)
    })
  }
  return removed
}

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
  /** Quote every cited chunk in full (local copy only); the committed packet quotes nothing. */
  full: boolean
  connectiveVerdicts?: readonly ConnectiveVerdict[]
}): string {
  const lines = [
    '# PR-6 tutor: human review packet',
    '',
    ...heading,
    '',
    '**Review status: pending.** Every case stays `"reviewed": false` in `scripts/tutor-eval-cases.json` until you change it. What you see passed the server gates and the model support check. Gates 2b–2d are lexical heuristics, and neither they nor the model check prove that a claim is supported. Judge each claim against the source at its timestamps.',
    '',
    full
      ? 'Local copy: every cited chunk is quoted in full. Do not commit or share it (third-party transcripts, redistribution not confirmed).'
      : 'No source text is quoted here (third-party transcripts, redistribution not confirmed). Follow the timestamp links, or regenerate the full local copy under `docs/evals/local/` with the command above.',
    '',
    'The help level is set by each case; the help policy is not exercised here. For each cited statement, mark one: `supported` · `not supported` · `wrong source`. For each connective, mark whether it states a fact the cited text does not. For each case, mark whether the answer is acceptable.',
  ]
  for (const section of sections) {
    lines.push('', '---', '', `# ${section.title}`, '', section.note)
    for (const evalCase of cases) {
      for (const result of section.results.filter((candidate) => candidate.caseId === evalCase.id)) {
        lines.push('', `## ${evalCase.id}${section.review ? '' : ` (${result.provenance.run})`}`, '')
        lines.push(`- **Code:** ${provenanceLine(result.provenance)}`)
        if (section.review) {
          lines.push(`- **Question:** ${evalCase.question}`)
          lines.push(`- **Lesson / playhead:** \`${evalCase.lessonId}\` at ${formatClock(evalCase.currentSeconds)}`)
          lines.push(`- **Help level:** ${evalCase.level} (set by the case)`)
        }
        if (result.scope === null) {
          lines.push('- **Outcome:** not found (unpublished or inaccessible lesson); no retrieval or model call.')
        } else if (result.error || !result.answer) {
          lines.push(`- **Outcome:** model call failed (${result.error}); the route would return a retryable 503.`)
        } else {
          const answer = result.answer
          lines.push(`- **Status / scope:** ${answer.status} / ${result.scope} (${result.evidenceCount} sources retrieved, ${answer.citedCount} cited)`)
          if (result.provenance.kind === 'stored') {
            const removed = replayCurrentGates(answer, evalCase.question, evalCase.level, textOf)
            const summary = removed === null ? 'not replayed (cited text unavailable)' : removed.length > 0 ? `would remove ${removed.join('; ')}` : 'would remove nothing'
            lines.push(`- **Current gates 2c/2d, replayed offline on this stored answer:** ${summary}.`)
          }
          if (section.review) lines.push(`- **What to check:** ${evalCase.notes}`)
          lines.push('')
          if (answer.statements.length === 0) lines.push('_No statements: the tutor said it could not find enough supporting material._')
          answer.statements.forEach((statement, i) => {
            lines.push(`${i + 1}. **[${statement.kind}]** ${statement.text}`)
            if (statement.citations.length > 0) {
              lines.push(`   - Cited: ${statement.citations.map((citation) => `[${formatClock(citation.startSeconds)}](${citation.href})`).join(' · ')} (${statement.citations[0].label.split(' · ')[0]})`)
              if (full) {
                for (const citation of statement.citations) lines.push(`     > ${formatClock(citation.startSeconds)}: ${textOf(citation.chunkId) ?? '(source text unavailable)'}`)
              }
              if (section.review) lines.push('   - Verdict: ☐ supported ☐ not supported ☐ wrong source')
            } else if (statement.kind === 'connective') {
              const verdict = connectiveVerdicts.find((candidate) => candidate.caseId === evalCase.id && candidate.text === statement.text)
              if (verdict) lines.push(`   - Connective check (run afterwards on this stored answer): ${verdict.verdict === 'supported' ? 'passed' : 'failed; the current tutor would drop it'}`)
              if (section.review) lines.push('   - States a fact the cited text does not? ☐ no ☐ yes')
            }
          })
          if (answer.followUp) lines.push('', `_Follow-up suggestion:_ ${answer.followUp}`)
          if (answer.dropped.length > 0) {
            lines.push('', 'Removed by the server before display:')
            for (const dropped of answer.dropped) {
              const where = dropped.uncitedChunkId ? ` (lexical heuristic: its wording is at ${formatClock(startOf(dropped.uncitedChunkId))})` : ''
              const detail = dropped.detail ? ` ("${dropped.detail}")` : ''
              // A dropped pointer's text is its chunk id: show where it pointed.
              const text = dropped.kind === 'pointer' ? `pointer to ${formatClock(startOf(dropped.text))}` : dropped.text
              lines.push(`- ${dropped.kind}, \`${dropped.reason}\`${where}${detail}: ${text}`)
            }
          }
        }
        if (section.review) lines.push('', '**Answer acceptable?** ☐ yes ☐ no — notes:')
      }
    }
  }
  return `${lines.join('\n')}\n`
}

const manifestSchema = z.object({
  out: z.string(),
  fullOut: z.string().startsWith('docs/evals/local/'),
  heading: z.array(z.string()),
  sections: z
    .array(
      z.object({
        title: z.string(),
        note: z.string(),
        review: z.boolean(),
        sources: z.array(z.object({results: z.string(), cases: z.array(z.string()).optional(), provenance: provenanceSchema})).min(1),
      }),
    )
    .min(1),
  connectiveVerdicts: z.string().optional(),
})

type StoredRow = PacketResult & {evidenceStarts?: string[]; commit?: string; dirty?: boolean; promptVersion?: string; supportPromptVersion?: string}

async function main(manifestPath: string) {
  const {createSanityHttp} = await import('./sanity-http.mts')
  const {evalCaseSchema} = await import('../lib/tutor/eval-check.ts')
  const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')))
  const cases = z.array(evalCaseSchema).parse(JSON.parse(await readFile(new URL('./tutor-eval-cases.json', import.meta.url), 'utf8')))
  const sections: PacketSection[] = []
  for (const section of manifest.sections) {
    const results: PacketResult[] = []
    for (const {results: file, cases: only, provenance} of section.sources) {
      for (const row of JSON.parse(await readFile(file, 'utf8')) as StoredRow[]) {
        if (only && !only.includes(row.caseId)) continue
        // Rows that record their own provenance must agree with the manifest.
        if (row.commit && (!provenance.commit.startsWith(row.commit) || row.dirty || row.promptVersion !== provenance.promptVersion || row.supportPromptVersion !== provenance.supportPromptVersion)) {
          throw new Error(`${file} ${row.caseId}: recorded ${row.commit}${row.dirty ? ' (dirty)' : ''} ${row.promptVersion}/${row.supportPromptVersion} does not match the manifest`)
        }
        results.push({caseId: row.caseId, scope: row.scope, error: row.error, answer: row.answer, evidenceCount: row.evidenceStarts?.length ?? 0, provenance})
      }
    }
    sections.push({title: section.title, note: section.note, review: section.review, results})
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
