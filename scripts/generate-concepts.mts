import {readFile, writeFile} from 'node:fs/promises'

import {openai, type OpenAILanguageModelResponsesOptions} from '@ai-sdk/openai'
import {z} from 'zod'

import {generateBoundedObject} from '../lib/ai/gateway.ts'
import type {LessonVideo} from '../lib/assessments/pipeline.ts'
import {
  conceptContentHash,
  conceptDraftSchema,
  planConcepts,
  type ConceptDraft,
  type ExistingConcept,
  type RecordedSpan,
} from '../lib/concepts/cluster.ts'
import {CONSOLIDATION_PROMPT_VERSION, toAcceptedMerge, type ConsolidationConcept, type ExistingProposal} from '../lib/concepts/consolidate.ts'
import {CONCEPT_EXTRACTION_PROMPT_VERSION, conceptCandidateSchema, conceptSourceRefSchema, type ConceptSourceRef} from '../lib/concepts/extract.ts'
import {
  extractCourse,
  extractionRecordSchema,
  proposeMerges,
  proposePrerequisites,
  type ConceptGenerateFn,
  type ConceptMutation,
  type CourseLesson,
  type ExtractionRecord,
} from '../lib/concepts/pipeline.ts'
import {PREREQUISITE_PROMPT_VERSION, type EdgeConcept, type ExistingEdge} from '../lib/concepts/prerequisites.ts'
import {toSourceChunks, type SourceChunk} from '../lib/evidence/chunks.ts'
import {parseVideoUrl} from '../lib/video/provider.ts'
import {createSanityHttp, requireEnv} from './sanity-http.mts'

/**
 * Offline concept generation (development plan §5 PR-3). Never runs in the
 * request path, and never publishes anything.
 *
 *   npm run generate:concepts -- extract --course <slug> [--limit N] [--dry-run] [--force] [--out file.json]
 *   npm run generate:concepts -- extract --lesson <slug> [--dry-run] ...
 *   npm run generate:concepts -- consolidate --course <slug> [--dry-run] [--force] [--out file.json]
 *   npm run generate:concepts -- consolidate --course <slug> --dry-run --concepts-from extract-out.json
 *   npm run generate:concepts -- prerequisites --course <slug> [--dry-run] [--force] [--out file.json]
 *   npm run generate:concepts -- prerequisites --course <slug> --dry-run --concepts-from extract-or-consolidate-out.json
 *
 * `extract`: one model call per bounded transcript span (never a whole
 * transcript). Each processed span gets a `conceptGenerationRecord` holding
 * its validated (and, for audit, rejected) candidates; concept drafts
 * (`drafts.concept-<conceptId>`, status "needs_review") are a deterministic
 * projection of every current record of the course plus the merge proposals
 * editors accepted; members of a rejected proposal that was already applied
 * are restored under their own ids. `--limit`/`--lesson` bound the model calls, not the
 * projection. A published concept is never written.
 *
 * `consolidate`: one bounded call over the course's reviewable concepts (at
 * most 120), drafting merge proposals (status "proposed") for editors to
 * accept or reject in the Studio. It merges nothing.
 *
 * `prerequisites`: one bounded call over the course's published, approved
 * concepts (at most 60, never truncated), drafting edges with status
 * "proposed".
 *
 * `--concepts-from` runs `consolidate` or `prerequisites` over an earlier
 * `--out` file instead, for auditing before anything is published; it
 * requires `--dry-run`. A `consolidate` file carries a hypothetical
 * consolidated concept set (every proposal treated as accepted) that
 * `prerequisites --concepts-from` uses.
 *
 * `--dry-run` writes nothing and plans exactly like a real run.
 */

const MODEL = 'gpt-5-mini'
const PROVIDER_OPTIONS = {
  openai: {reasoningEffort: 'medium', reasoningSummary: null} satisfies OpenAILanguageModelResponsesOptions,
}
/** Reasoning tokens count against these budgets; truncated output fails validation and is retried next run. */
const LIMITS = {
  'concept-extraction': {maxOutputTokens: 4000, timeoutMs: 90_000, promptVersion: CONCEPT_EXTRACTION_PROMPT_VERSION},
  'concept-consolidation': {maxOutputTokens: 16_000, timeoutMs: 180_000, promptVersion: CONSOLIDATION_PROMPT_VERSION},
  'concept-prerequisites': {maxOutputTokens: 16_000, timeoutMs: 120_000, promptVersion: PREREQUISITE_PROMPT_VERSION},
} as const
/** Spend cap per run; remaining spans are reported as deferred. */
const MAX_MODEL_CALLS_PER_RUN = 100

/**
 * Lenient on purpose: also reads v1 `extract` files (no candidate ids or
 * roles) so consolidation can be checked against the v1 pilot set. The
 * hypothetical consolidated set needs the v2 file's recorded spans.
 */
const looseConcept = z.object({
  conceptId: z.string().min(1),
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  summary: z.string().min(1),
  sourceRefs: z.array(conceptSourceRefSchema),
  generation: z.object({candidateIds: z.array(z.string()).optional()}).optional(),
})
const looseSpan = z.object({
  lessonId: z.string(),
  lessonOrder: z.number(),
  spanIndex: z.number(),
  extractionKey: z.string(),
  candidates: z.array(conceptCandidateSchema),
})

type Lesson = {_id: string; title: string; slug: string; videoUrl: string | null}
type Course = {_id: string; title: string; slug: string; lessons: Lesson[]}
type Command = 'extract' | 'consolidate' | 'prerequisites'
type Args = {
  command: Command
  scope: {kind: 'course' | 'lesson'; slug: string}
  limit: number | null
  dryRun: boolean
  force: boolean
  out: string | null
  conceptsFrom: string | null
}

const args = parseArgs(process.argv.slice(2))
const sanity = createSanityHttp()
if (!args.dryRun && !sanity.canWrite) {
  console.error('Missing SANITY_API_WRITE_TOKEN (required to write; use --dry-run to generate without writing).')
  process.exit(1)
}
requireEnv('OPENAI_API_KEY')

const generate = (({task, system, prompt, schema}) =>
  generateBoundedObject({
    model: openai(MODEL),
    schema,
    system,
    prompt,
    maxOutputTokens: LIMITS[task].maxOutputTokens,
    timeoutMs: LIMITS[task].timeoutMs,
    providerOptions: PROVIDER_OPTIONS,
    versions: {task, promptVersion: LIMITS[task].promptVersion},
  })) as ConceptGenerateFn

const {course, inScope} = await resolveScope()
console.log(
  `${course.title}: ${course.lessons.length} lesson(s), ${inScope.size} in scope${args.dryRun ? ' (dry run)' : ''}${args.force ? ' (force)' : ''}\n`,
)
const videos = await fetchVideos(course.lessons)
const chunks = new Map<string, SourceChunk>()
for (const video of videos.values()) for (const chunk of toSourceChunks(video)) chunks.set(chunk.chunkId, chunk)
const lessonIds = course.lessons.map((lesson) => lesson._id)

const failed =
  args.command === 'extract' ? await runExtract() : args.command === 'consolidate' ? await runConsolidate() : await runPrerequisites()
process.exit(failed ? 1 : 0)

function tally(values: ReadonlyArray<string>): string {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return (
    [...counts]
      .toSorted(([, a], [, b]) => b - a)
      .map(([name, count]) => `${name} ${count}`)
      .join(', ') || 'none'
  )
}

async function runExtract(): Promise<boolean> {
  const [recordRows, existingConcepts, existingEdges, proposalRows] = await Promise.all([
    sanity.groq<unknown[] | null>(
      '*[_type == "conceptGenerationRecord" && kind == "span_extraction" && lesson._ref in $lessonIds]',
      {lessonIds},
      'raw',
    ),
    fetchExistingConcepts(),
    sanity.groq<Array<{_id: string; sourceStatus?: string | null; evidence?: Array<{chunkId: string; chunkRevision: string}> | null}> | null>(
      '*[_type == "conceptPrerequisite"]{_id, sourceStatus, evidence[]{chunkId, chunkRevision}}',
      {},
      'raw',
    ),
    sanity.groq<Array<Parameters<typeof toAcceptedMerge>[0] & {status: string}> | null>(
      '*[_type == "conceptMergeProposal" && generation.course._ref == $courseId]{_id, status, canonical{candidateIds}, members[]{conceptId, candidateIds}}',
      {courseId: course._id},
      'raw',
    ),
  ])
  const recorded = new Map<string, ExtractionRecord>()
  for (const row of recordRows ?? []) {
    const parsed = extractionRecordSchema.safeParse(row)
    if (parsed.success) recorded.set(parsed.data.key, parsed.data)
  }

  const lessons: CourseLesson[] = course.lessons.map((lesson, order) => ({
    lesson: {_id: lesson._id, title: lesson.title},
    order,
    video: videos.get(lesson._id) ?? null,
    inScope: inScope.has(lesson._id),
  }))
  const result = await extractCourse({
    course,
    lessons,
    recorded,
    existingConcepts,
    existingEdges: existingEdges ?? [],
    acceptedMerges: (proposalRows ?? []).filter((row) => row.status === 'accepted').map(toAcceptedMerge),
    // Rejected, or set back to proposed: an already-applied merge is undone.
    rejectedMerges: (proposalRows ?? []).filter((row) => row.status !== 'accepted').map(toAcceptedMerge),
    force: args.force,
    model: MODEL,
    generate,
    budget: {remaining: MAX_MODEL_CALLS_PER_RUN},
  })

  const committed = await execute(result.transactions)
  const slugOf = new Map(course.lessons.map((lesson) => [lesson._id, lesson.slug]))
  for (const span of result.spans) console.log(`${span.status.padEnd(14)} ${slugOf.get(span.lessonId)} #${span.spanIndex}  ${span.detail}`)

  const byKey = new Map([...recorded].concat(result.records.map((record) => [record.key, record] as const)))
  const current = result.currentSpans.flatMap((span) => (byKey.has(span.extractionKey) ? [byKey.get(span.extractionKey)!] : []))
  const candidates = current.flatMap((record) => record.candidates)
  const rejected = current.flatMap((record) => record.rejectedCandidates)
  const {plan} = result
  const verb = args.dryRun ? 'would be' : 'were'
  console.log(
    [
      '',
      `spans: ${tally(result.spans.map((span) => span.status))}; ${result.modelCalls} model call(s)`,
      `candidates (current records): ${candidates.length} — ${tally(candidates.map((candidate) => candidate.role))}`,
      `rejected candidates: ${rejected.length} — ${tally(rejected.map((entry) => entry.reason.split(':')[0]))}`,
      `facts/details excluded by the model: ${current.reduce((sum, record) => sum + record.excludedDetails.length, 0)}; incidental details rejected: ${rejected.filter((entry) => entry.reason.startsWith('incidental_detail')).length}; aliases dropped: ${current.reduce((sum, record) => sum + record.droppedAliases, 0)}`,
      `clusters: ${plan.clusters} (${plan.lexicalGroups} lexical duplicate group(s)); ${plan.drafts.length} concept draft(s) ${verb} written (${tally(plan.drafts.map((draft) => draft.generation.role))}); ${plan.unchanged.length} unchanged; ${plan.editorModified.length} editor-modified left alone`,
      `merges: ${plan.merges.applied.length} applied, ${plan.merges.stale.length} stale, ${plan.merges.needsManual.length} need a manual tombstone merge, ${plan.merges.overlapping.length} overlapping; ${plan.mergeDeletes.length} absorbed draft(s) ${verb} deleted; ${plan.merges.restored.length} member(s) of rejected merges ${verb} restored`,
      `evidence for published concepts (not written): ${plan.evidenceForPublished.map((entry) => entry.conceptId).join(', ') || 'none'}`,
      `rejected concepts: ${plan.suppressedRejected.length} suppressed (same versions), ${plan.reconsidered.length} reconsidered; retired matches: ${plan.matchesRetired.length}`,
      `conflicts (nothing written): ${plan.conflicts.map((entry) => `${entry.names.join('/')} ↔ ${entry.conceptIds.join(', ')}`).join('; ') || 'none'}`,
      `source refs dropped by the per-concept cap: ${plan.droppedSourceRefs}`,
      `${result.staleIds.length} document(s) ${args.dryRun ? 'would be marked' : 'marked'} stale; ${result.deletedIds.length} unreproduced draft(s) ${verb} deleted; ${plan.unreproduced.length} unreproduced in total`,
      `lessons without a transcript: ${result.lessonsWithoutTranscript.map((id) => slugOf.get(id)).join(', ') || 'none'}`,
      `records ${verb} written: ${result.records.length}`,
      args.dryRun ? null : `transactions committed: ${committed}/${result.transactions.length}`,
    ]
      .filter((line) => line !== null)
      .join('\n'),
  )
  for (const draft of plan.drafts) {
    console.log(`  ${draft.generation.role === 'secondary' ? '+' : ' '}${draft.conceptId}: ${draft.name} — ${draft.lessons.length} lesson(s), ${draft.sourceRefs.length} ref(s), ${draft.generation.candidateIds.length} candidate(s)`)
  }
  if (args.out) {
    await writeFile(
      args.out,
      `${JSON.stringify(
        {command: 'extract', course: {_id: course._id, slug: course.slug}, dryRun: args.dryRun, drafts: plan.drafts, records: current, currentSpans: result.currentSpans, plan: {...plan, drafts: undefined}},
        null,
        2,
      )}\n`,
    )
    console.log(`\nWrote ${plan.drafts.length} draft(s) and ${current.length} current record(s) to ${args.out}`)
  }
  return result.spans.some((span) => span.status === 'failed')
}

async function runConsolidate(): Promise<boolean> {
  const source = args.conceptsFrom ? await readConsolidationFile(args.conceptsFrom) : {concepts: await fetchConsolidationConcepts(), spans: null}
  const [existingProposals, recordedKeys] = await Promise.all([
    sanity.groq<ExistingProposal[] | null>(
      `*[_type == "conceptMergeProposal" && generation.course._ref == $courseId]{
        _id, status, rationale, "canonicalConceptId": canonical.conceptId,
        "memberConceptIds": members[].conceptId, "evidenceChunkIds": evidence[].chunkId, "contentHash": generation.contentHash
      }`,
      {courseId: course._id},
      'raw',
    ),
    sanity.groq<string[] | null>(
      '*[_type == "conceptGenerationRecord" && kind == "course_consolidation" && course._ref == $courseId].key',
      {courseId: course._id},
      'raw',
    ),
  ])
  console.log(`${source.concepts.length} concept(s)${args.conceptsFrom ? ` from ${args.conceptsFrom}` : ' (drafts and published, not rejected or retired)'}`)
  const result = await proposeMerges({
    course,
    concepts: source.concepts,
    existingProposals: existingProposals ?? [],
    recordedKeys: new Set(recordedKeys ?? []),
    force: args.force,
    model: MODEL,
    generate,
  })
  const committed = await execute(result.transactions)
  console.log(`\n${result.status}: ${result.detail}; ${result.modelCalls} model call(s)`)

  let consolidatedDrafts: ConceptDraft[] | null = null
  if (result.plan) {
    const names = new Map(source.concepts.map((concept) => [concept.conceptId, concept.name]))
    result.plan.groups.forEach((group, i) => {
      const [canonical, ...rest] = result.plan!.memberConceptIds[i]
      console.log(`  ${names.get(canonical)}  ⇐  ${rest.map((id) => names.get(id)).join(' | ')}`)
    })
    for (const draft of result.plan.drafts) console.log(`    ${draft._id}: ${draft.rationale} (evidence: ${draft.evidence.map((ref) => ref.chunkId).join(', ')})`)
    for (const rejection of result.plan.rejections) console.log(`  rejected ${rejection.group}: ${rejection.reason}`)
    if (source.spans) {
      const hypothetical = planConcepts({
        spans: source.spans,
        existing: [],
        courseId: course._id,
        model: MODEL,
        chunkText: new Map([...chunks.values()].map((chunk) => [chunk.chunkId, chunk.text])),
        now: new Date(),
        acceptedMerges: result.plan.groups,
      })
      consolidatedDrafts = hypothetical.drafts
      console.log(
        `hypothetical consolidated set (every proposal accepted): ${hypothetical.drafts.length} concept(s); ${hypothetical.merges.applied.length} merge(s) applied, ${hypothetical.merges.stale.length} stale, ${hypothetical.merges.overlapping.length} overlapping`,
      )
    }
    const verb = args.dryRun ? 'would be' : 'were'
    console.log(`${result.plan.drafts.length} proposal draft(s) ${verb} written${args.dryRun ? '' : `; transactions committed: ${committed}/${result.transactions.length}`}`)
  }
  if (args.out) {
    await writeFile(
      args.out,
      `${JSON.stringify(
        {
          command: 'consolidate',
          course: {_id: course._id, slug: course.slug},
          dryRun: args.dryRun,
          hypothetical: consolidatedDrafts !== null,
          status: result.status,
          detail: result.detail,
          estimatedCount: result.estimatedCount,
          proposals: result.plan?.drafts ?? [],
          groups: result.plan?.memberConceptIds ?? [],
          rejections: result.plan?.rejections ?? [],
          record: result.record,
          consolidatedDrafts,
        },
        null,
        2,
      )}\n`,
    )
    console.log(`Wrote the proposals to ${args.out}`)
  }
  return result.status === 'failed' || result.status === 'refused'
}

async function runPrerequisites(): Promise<boolean> {
  type ConceptRow = Pick<ConceptDraft, 'conceptId' | 'name' | 'aliases' | 'summary' | 'objectives' | 'sourceRefs' | 'lessons'>
  const rows: ConceptRow[] = args.conceptsFrom
    ? await readPrerequisiteFile(args.conceptsFrom)
    : ((await sanity.groq<ConceptRow[] | null>(
        `*[_type == "concept" && reviewStatus == "approved" && sourceStatus == "current" && count((lessons[]._ref)[@ in $lessonIds]) > 0]{
          conceptId, name, "aliases": coalesce(aliases, []), summary, objectives[]{_key, _type, text},
          sourceRefs[]{_key, _type, chunkId, chunkRevision, startSeconds, endSeconds, lesson}, lessons[]{_key, _type, _ref}
        }`,
        {lessonIds},
        'published',
      )) ?? [])
  const concepts: EdgeConcept[] = rows.map((row) => ({
    conceptId: row.conceptId,
    contentHash: conceptContentHash(row),
    name: row.name,
    summary: row.summary,
    evidence: currentEvidence(row.sourceRefs),
  }))

  const [existingEdges, recordedKeys] = await Promise.all([
    sanity.groq<ExistingEdge[] | null>(
      '*[_type == "conceptPrerequisite"]{_id, status, "prerequisite": prerequisite._ref, "dependent": dependent._ref, rationale, evidence[]{chunkId, chunkRevision}, "contentHash": generation.contentHash, "suppressionKey": generation.suppressionKey}',
      {},
      'raw',
    ),
    sanity.groq<string[] | null>(
      '*[_type == "conceptGenerationRecord" && kind == "course_prerequisites" && course._ref == $courseId].key',
      {courseId: course._id},
      'raw',
    ),
  ])
  const edges = existingEdges ?? []
  const activeEdges = edges
    .filter((edge) => !/^(drafts|versions)\./.test(edge._id) && edge.status === 'approved' && edge.prerequisite && edge.dependent)
    .map((edge) => ({prerequisite: edge.prerequisite!, dependent: edge.dependent!}))

  console.log(`${concepts.length} concept(s)${args.conceptsFrom ? ` from ${args.conceptsFrom}` : ' (published, approved)'}; ${concepts.filter((concept) => concept.evidence.length === 0).length} without current evidence`)
  const result = await proposePrerequisites({
    course,
    concepts,
    existingEdges: edges,
    activeEdges,
    recordedKeys: new Set(recordedKeys ?? []),
    force: args.force,
    model: MODEL,
    generate,
  })
  const committed = await execute(result.transactions)

  console.log(`\n${result.status}: ${result.detail}; ${result.modelCalls} model call(s)`)
  if (result.plan) {
    for (const draft of result.plan.drafts) {
      console.log(`  ${draft.prerequisite._ref.replace(/^concept-/, '')} → ${draft.dependent._ref.replace(/^concept-/, '')}: ${draft.rationale}`)
    }
    for (const rejection of result.plan.rejections) console.log(`  rejected ${rejection.pair}: ${rejection.reason}`)
    for (const cycle of result.plan.cycles) console.log(`  cycle: ${cycle.join(' ⇄ ')}`)
    const verb = args.dryRun ? 'would be' : 'were'
    console.log(`${result.plan.drafts.length} edge draft(s) ${verb} written${args.dryRun ? '' : `; transactions committed: ${committed}/${result.transactions.length}`}`)
  }
  if (args.out) {
    await writeFile(args.out, `${JSON.stringify({command: 'prerequisites', course: {_id: course._id, slug: course.slug}, dryRun: args.dryRun, ...result}, null, 2)}\n`)
    console.log(`Wrote the proposal to ${args.out}`)
  }
  return result.status === 'failed' || result.status === 'refused'
}

/** Current chunks (matching revision) cited by `refs`, with their text for bounded prompts. */
function currentEvidence(refs: ReadonlyArray<ConceptSourceRef>): Array<ConceptSourceRef & {text: string}> {
  return refs.flatMap((ref) => {
    const chunk = chunks.get(ref.chunkId)
    return chunk && chunk.chunkRevision === ref.chunkRevision ? [{...ref, text: chunk.text}] : []
  })
}

/** Runs each transaction atomically, in order; returns how many committed. Dry runs commit nothing. */
async function execute(transactions: ConceptMutation[][]): Promise<number> {
  if (args.dryRun) return 0
  let committed = 0
  for (const transaction of transactions) {
    try {
      await sanity.mutate(transaction)
    } catch (error) {
      console.error(`Transaction ${committed + 1}/${transactions.length} failed after ${committed} committed; rerun to continue.`)
      throw error
    }
    committed++
  }
  return committed
}

async function readOutFile(path: string): Promise<Record<string, unknown>> {
  const file = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  if ((file.course as {_id?: string} | undefined)?._id !== course._id) {
    console.error(`${path} was generated for another course.`)
    process.exit(1)
  }
  return file
}

/** Concept drafts from an `extract` file, or the hypothetical consolidated set from a `consolidate` file. */
async function readPrerequisiteFile(path: string): Promise<ConceptDraft[]> {
  const file = await readOutFile(path)
  const drafts = file.command === 'consolidate' ? file.consolidatedDrafts : file.command === 'extract' ? file.drafts : null
  if (!Array.isArray(drafts)) {
    console.error(`${path} is neither an \`extract --out\` file nor a \`consolidate --out\` file with a consolidated set.`)
    process.exit(1)
  }
  return drafts.map((draft) => conceptDraftSchema.parse(draft))
}

async function readConsolidationFile(path: string): Promise<{concepts: ConsolidationConcept[]; spans: RecordedSpan[] | null}> {
  const file = await readOutFile(path)
  if (file.command !== 'extract' || !Array.isArray(file.drafts)) {
    console.error(`${path} is not an \`extract --out\` file.`)
    process.exit(1)
  }
  const concepts = file.drafts.map((draft) => {
    const row = looseConcept.parse(draft)
    return {
      conceptId: row.conceptId,
      name: row.name,
      aliases: row.aliases,
      summary: row.summary,
      candidateIds: row.generation?.candidateIds ?? [],
      evidence: currentEvidence(row.sourceRefs),
    }
  })
  const spans = z.array(looseSpan).safeParse(file.currentSpans)
  return {concepts, spans: spans.success ? spans.data : null}
}

/** Reviewable concepts of the course from the dataset: drafts preferred over their published version. */
async function fetchConsolidationConcepts(): Promise<ConsolidationConcept[]> {
  const rows =
    (await sanity.groq<Array<{_id: string; conceptId: string; name: string; aliases: string[]; summary: string; sourceRefs: ConceptSourceRef[]; candidateIds: string[]}> | null>(
      `*[_type == "concept" && !(reviewStatus in ["rejected", "merged", "split", "archived"]) && count((lessons[]._ref)[@ in $lessonIds]) > 0]{
        _id, conceptId, name, "aliases": coalesce(aliases, []), summary,
        "sourceRefs": coalesce(sourceRefs[]{_key, _type, chunkId, chunkRevision, startSeconds, endSeconds, lesson}, []),
        "candidateIds": coalesce(generation.candidateIds, [])
      }`,
      {lessonIds},
      'raw',
    )) ?? []
  const byConcept = new Map<string, (typeof rows)[number]>()
  for (const row of rows) if (!byConcept.has(row.conceptId) || row._id.startsWith('drafts.')) byConcept.set(row.conceptId, row)
  return [...byConcept.values()].map((row) => ({
    conceptId: row.conceptId,
    name: row.name,
    aliases: row.aliases,
    summary: row.summary,
    candidateIds: row.candidateIds,
    evidence: currentEvidence(row.sourceRefs),
  }))
}

async function fetchExistingConcepts(): Promise<Array<ExistingConcept & {sourceStatus?: string | null}>> {
  const rows = await sanity.groq<Array<ExistingConcept & {sourceStatus?: string | null}> | null>(
    `*[_type == "concept"]{
      _id, conceptId, name, "aliases": coalesce(aliases, []), summary, "objectives": coalesce(objectives[]{text}, []),
      "sourceRefs": coalesce(sourceRefs[]{chunkId, chunkRevision, lesson}, []), "lessons": coalesce(lessons[]{_ref}, []),
      reviewStatus, sourceStatus, "mergedInto": mergedInto._ref,
      "generationCourse": generation.course._ref, "contentHash": generation.contentHash, "suppressionKey": generation.suppressionKey,
      "appliedMerges": generation.appliedMerges
    }`,
    {},
    'raw',
  )
  return rows ?? []
}

async function fetchVideos(lessons: Lesson[]): Promise<Map<string, LessonVideo>> {
  const videoIdByLesson = new Map<string, string>()
  for (const lesson of lessons) {
    const parsed = parseVideoUrl(lesson.videoUrl)
    if (parsed) videoIdByLesson.set(lesson._id, parsed.documentId)
  }
  const rows = await sanity.groq<LessonVideo[] | null>(
    '*[_id in $ids]{_id, durationSeconds, chapters[]{startSeconds, label}, transcriptChunks[]{_key, startSeconds, text}}',
    {ids: [...new Set(videoIdByLesson.values())]},
    'published',
  )
  const byId = new Map((rows ?? []).map((video) => [video._id, video]))
  const out = new Map<string, LessonVideo>()
  for (const [lessonId, videoId] of videoIdByLesson) {
    const video = byId.get(videoId)
    if (video) out.set(lessonId, video)
  }
  return out
}

async function resolveScope(): Promise<{course: Course; inScope: Set<string>}> {
  const courseProjection = '{_id, title, "slug": slug.current, "lessons": modules[].lessons[]->{_id, title, "slug": slug.current, videoUrl}}'
  let courses: Array<Course | null>
  let lessonId: string | null = null
  if (args.scope.kind === 'course') {
    courses = (await sanity.groq<Course[] | null>(`*[_type == "course" && slug.current == $slug]${courseProjection}`, {slug: args.scope.slug}, 'published')) ?? []
  } else {
    lessonId = await sanity.groq<string | null>('*[_type == "lesson" && slug.current == $slug][0]._id', {slug: args.scope.slug}, 'published')
    if (!lessonId) {
      console.error(`No published lesson "${args.scope.slug}".`)
      process.exit(1)
    }
    courses = (await sanity.groq<Course[] | null>(`*[_type == "course" && references($lessonId)]${courseProjection}`, {lessonId}, 'published')) ?? []
  }
  if (courses.length !== 1 || !courses[0]) {
    console.error(`Expected exactly one published course for ${args.scope.kind} "${args.scope.slug}", found ${courses.length}.`)
    process.exit(1)
  }
  const found = courses[0]
  const unique = new Map<string, Lesson>()
  for (const lesson of found.lessons ?? []) if (lesson?._id && !unique.has(lesson._id)) unique.set(lesson._id, lesson)
  const lessons = [...unique.values()]
  const scoped = lessonId ? lessons.filter((lesson) => lesson._id === lessonId) : lessons
  const bounded = args.limit ? scoped.slice(0, args.limit) : scoped
  return {course: {...found, lessons}, inScope: new Set(bounded.map((lesson) => lesson._id))}
}

function parseArgs(argv: string[]): Args {
  const usage =
    'Usage: generate-concepts (extract | consolidate | prerequisites) (--course <slug> | --lesson <slug>) [--limit N] [--dry-run] [--force] [--out file.json] [--concepts-from file.json]'
  const fail = (message: string): never => {
    console.error(`${message} ${usage}`)
    process.exit(1)
  }
  const [command, ...rest] = argv
  if (command !== 'extract' && command !== 'consolidate' && command !== 'prerequisites') return fail('A command is required.')
  let scope: Args['scope'] | null = null
  let limit: number | null = null
  let dryRun = false
  let force = false
  let out: string | null = null
  let conceptsFrom: string | null = null
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === '--dry-run') dryRun = true
    else if (arg === '--force') force = true
    else if ((arg === '--course' || arg === '--lesson') && rest[i + 1] && !scope) {
      scope = {kind: arg === '--course' ? 'course' : 'lesson', slug: rest[++i]}
    } else if (arg === '--limit') {
      const value = Number(rest[++i])
      if (!Number.isInteger(value) || value < 1) fail('--limit expects a positive integer.')
      limit = value
    } else if (arg === '--out' && rest[i + 1]) out = rest[++i]
    else if (arg === '--concepts-from' && rest[i + 1]) conceptsFrom = rest[++i]
    else fail(`Unexpected argument ${arg}.`)
  }
  if (!scope) return fail('A scope is required.')
  if (command !== 'extract' && (scope.kind !== 'course' || limit !== null)) fail(`${command} takes --course only.`)
  if (conceptsFrom && (command === 'extract' || !dryRun)) {
    fail('--concepts-from is for consolidate or prerequisites with --dry-run only: nothing may be written from a file.')
  }
  return {command, scope, limit, dryRun, force, out, conceptsFrom}
}
