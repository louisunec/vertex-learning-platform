import {readFile, writeFile} from 'node:fs/promises'

import {z} from 'zod'

import {toSourceChunks} from '../lib/evidence/chunks.ts'
import {parseVideoUrl} from '../lib/video/provider.ts'
import {createSanityHttp} from './sanity-http.mts'

/**
 * Drafts an explanation task for editorial review (development plan §5 PR-8).
 * Read-only against Sanity: it resolves the spec's lesson, its transcript
 * chunks (id, revision, and time range from the whole transcript), and each
 * criterion's approved concept and objective, and writes one
 * `drafts.explanationTask-<taskId>` document as ndjson. It never writes to
 * Sanity and never approves anything: an editor imports the file, reviews it
 * in the Studio, and publishes it.
 *
 *   npm run draft:explanation-task -- docs/explain-back/local/<task>.task.json [--out <file.ndjson>]
 *
 * Real task specs and drafts stay in the gitignored `docs/explain-back/local/`:
 * the private points state the answers (docs/explain-back/README.md).
 *
 * Then, from studio/:  npx sanity dataset import <file.ndjson> <dataset> --missing
 * (`--missing` never replaces an existing document). Re-run it after a
 * transcript change: a task whose chunk revisions no longer match is hidden
 * from learners until a new version is reviewed and published.
 */

const criterionSchema = z.strictObject({
  key: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  label: z.string().min(1).max(120),
  point: z.string().min(1).max(400),
  required: z.boolean(),
  conceptId: z.string().regex(/^cpt-[a-z0-9-]+$/),
  objectiveKey: z.string().min(1).max(64).optional(),
  sourceChunkKeys: z.array(z.string().min(1)).min(1).max(6),
})

const specSchema = z.strictObject({
  taskId: z.string().regex(/^[a-z0-9-]{3,64}$/),
  lessonSlug: z.string().min(1),
  title: z.string().min(1).max(120),
  prompt: z.string().min(1).max(600),
  criteria: z.array(criterionSchema).min(1).max(5),
  version: z.number().int().min(1).default(1),
})

const args = process.argv.slice(2)
const specPath = args.find((arg) => !arg.startsWith('--'))
const outIndex = args.indexOf('--out')
const outPath = outIndex >= 0 ? args[outIndex + 1] : null
if (!specPath || (outIndex >= 0 && !outPath)) {
  console.error('Usage: npm run draft:explanation-task -- <spec.json> [--out <file.ndjson>]')
  process.exit(1)
}

const spec = specSchema.parse(JSON.parse(await readFile(specPath, 'utf8')))
if (new Set(spec.criteria.map((criterion) => criterion.key)).size !== spec.criteria.length) throw new Error('Criterion keys must be unique.')
if (!spec.criteria.some((criterion) => criterion.required)) throw new Error('At least one criterion must be required.')

const sanity = createSanityHttp()

const lesson = await sanity.groq<{_id: string; title: string; videoUrl: string | null} | null>(
  '*[_type == "lesson" && slug.current == $slug && !(_id in path("drafts.**")) && !(_id in path("versions.**"))][0]{_id, title, videoUrl}',
  {slug: spec.lessonSlug},
  'published',
)
if (!lesson) throw new Error(`No published lesson "${spec.lessonSlug}".`)
const video = parseVideoUrl(lesson.videoUrl)
if (!video) throw new Error(`Lesson "${spec.lessonSlug}" has no supported video URL.`)

const videoRow = await sanity.groq<{_id: string; durationSeconds: number | null; transcriptChunks: Array<{_key: string; startSeconds: number; text: string}> | null} | null>(
  '*[_type == "video" && _id == $id][0]{_id, durationSeconds, transcriptChunks[]{_key, startSeconds, text}}',
  {id: video.documentId},
  'published',
)
if (!videoRow) throw new Error(`No published video record ${video.documentId}.`)
// Offline only: the whole transcript is read here to derive each chunk's end, never in a request path.
const chunks = new Map(toSourceChunks(videoRow).map((chunk) => [chunk.chunkId.slice(chunk.chunkId.lastIndexOf(':') + 1), chunk]))

const taskKeys = [...new Set(spec.criteria.flatMap((criterion) => criterion.sourceChunkKeys))]
if (taskKeys.length > 10) throw new Error(`A task cites at most 10 source chunks (${taskKeys.length} given).`)
const sourceChunkRefs = taskKeys
  .map((key) => {
    const chunk = chunks.get(key)
    if (!chunk) throw new Error(`Chunk "${key}" is not in ${video.documentId}.`)
    return {_key: key, _type: 'sourceChunkRef', chunkId: chunk.chunkId, chunkRevision: chunk.chunkRevision, startSeconds: chunk.startSeconds, endSeconds: chunk.endSeconds}
  })
  .toSorted((a, b) => a.startSeconds - b.startSeconds)

const conceptIds = [...new Set(spec.criteria.map((criterion) => criterion.conceptId))]
const concepts = await sanity.groq<Array<{_id: string; conceptId: string; objectiveKeys: string[] | null}>>(
  '*[_type == "concept" && conceptId in $ids && reviewStatus == "approved" && !(_id in path("drafts.**")) && !(_id in path("versions.**"))]{_id, conceptId, "objectiveKeys": objectives[]._key}',
  {ids: conceptIds},
  'published',
)
const conceptById = new Map(concepts.map((concept) => [concept.conceptId, concept]))
const missing = conceptIds.filter((id) => !conceptById.has(id))
if (missing.length > 0) throw new Error(`Not approved and published: ${missing.join(', ')}.`)

const criteria = spec.criteria.map((criterion) => {
  const concept = conceptById.get(criterion.conceptId)!
  if (criterion.objectiveKey && !(concept.objectiveKeys ?? []).includes(criterion.objectiveKey)) {
    throw new Error(`Objective "${criterion.objectiveKey}" is not one of ${criterion.conceptId}'s objectives.`)
  }
  return {
    _key: criterion.key,
    _type: 'explanationCriterion',
    label: criterion.label,
    point: criterion.point,
    required: criterion.required,
    concept: {_type: 'reference', _ref: concept._id},
    ...(criterion.objectiveKey ? {objectiveKey: criterion.objectiveKey} : {}),
    sourceChunkIds: criterion.sourceChunkKeys.map((key) => chunks.get(key)!.chunkId),
  }
})

const draft = {
  _id: `drafts.explanationTask-${spec.taskId}`,
  _type: 'explanationTask',
  reviewStatus: 'needs_review',
  taskId: spec.taskId,
  version: spec.version,
  lesson: {_type: 'reference', _ref: lesson._id},
  title: spec.title,
  prompt: spec.prompt,
  criteria,
  sourceChunkRefs,
  review: {promptNarrow: false, pointsObservable: false, requiredMinimal: false, labelsHideAnswer: false, sourcesSupport: false, conceptsRelevant: false},
}

const line = `${JSON.stringify(draft)}\n`
if (outPath) {
  await writeFile(outPath, line)
  console.log(`Wrote ${draft._id} (${criteria.length} points, ${sourceChunkRefs.length} source chunks, ${concepts.length} concepts) to ${outPath}. Nothing was written to Sanity.`)
} else {
  process.stdout.write(line)
}
