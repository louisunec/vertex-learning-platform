import {readFile, writeFile} from 'node:fs/promises'

import {z} from 'zod'

import {toSourceChunks} from '../lib/evidence/chunks.ts'
import {parseVideoUrl} from '../lib/video/provider.ts'
import {createSanityHttp} from './sanity-http.mts'

/**
 * Drafts a submission task for editorial review (development plan §5 PR-12).
 * Read-only against Sanity: it resolves the spec's lesson, its transcript
 * chunks (id, revision, and time range from the whole transcript), and its
 * approved concepts, and writes one `drafts.submissionTask-<taskId>` document
 * as ndjson. It never writes to Sanity and never approves anything: an editor
 * imports the file, reviews it in the Studio, and publishes it.
 *
 *   npm run draft:submission-task -- docs/submission-review/<task>.task.json [--out <file.ndjson>]
 *
 * Then, from studio/:  npx sanity dataset import <file.ndjson> <dataset> --missing
 * (`--missing` never replaces an existing document). Re-run it after a
 * transcript change: a task whose chunk revisions no longer match is hidden
 * from learners until a new version is reviewed and published.
 */

const specSchema = z.strictObject({
  taskId: z.string().regex(/^[a-z0-9-]{3,64}$/),
  lessonSlug: z.string().min(1),
  title: z.string().min(1).max(120),
  language: z.enum(['javascript', 'typescript', 'python', 'sql']),
  instructions: z.string().min(1).max(2000),
  criteria: z
    .array(z.strictObject({key: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), text: z.string().min(1).max(300)}))
    .min(1)
    .max(8),
  conceptIds: z.array(z.string().min(1)).max(4),
  sourceChunkKeys: z.array(z.string().min(1)).min(1).max(8),
  version: z.number().int().min(1).default(1),
})

const args = process.argv.slice(2)
const specPath = args.find((arg) => !arg.startsWith('--'))
const outIndex = args.indexOf('--out')
const outPath = outIndex >= 0 ? args[outIndex + 1] : null
if (!specPath || (outIndex >= 0 && !outPath)) {
  console.error('Usage: npm run draft:submission-task -- <spec.json> [--out <file.ndjson>]')
  process.exit(1)
}

const spec = specSchema.parse(JSON.parse(await readFile(specPath, 'utf8')))
if (new Set(spec.criteria.map((criterion) => criterion.key)).size !== spec.criteria.length) throw new Error('Criterion keys must be unique.')

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

const sourceChunkRefs = spec.sourceChunkKeys.map((key) => {
  const chunk = chunks.get(key)
  if (!chunk) throw new Error(`Chunk "${key}" is not in ${video.documentId}.`)
  return {_key: key, _type: 'sourceChunkRef', chunkId: chunk.chunkId, chunkRevision: chunk.chunkRevision, startSeconds: chunk.startSeconds, endSeconds: chunk.endSeconds}
})

const concepts = spec.conceptIds.length
  ? await sanity.groq<Array<{_id: string; conceptId: string}>>(
      '*[_type == "concept" && conceptId in $ids && reviewStatus == "approved" && !(_id in path("drafts.**"))]{_id, conceptId}',
      {ids: spec.conceptIds},
      'published',
    )
  : []
const missing = spec.conceptIds.filter((id) => !concepts.some((concept) => concept.conceptId === id))
if (missing.length > 0) throw new Error(`Not approved and published: ${missing.join(', ')}.`)

const draft = {
  _id: `drafts.submissionTask-${spec.taskId}`,
  _type: 'submissionTask',
  reviewStatus: 'needs_review',
  taskId: spec.taskId,
  version: spec.version,
  lesson: {_type: 'reference', _ref: lesson._id},
  title: spec.title,
  instructions: spec.instructions,
  language: spec.language,
  criteria: spec.criteria.map((criterion) => ({_key: criterion.key, _type: 'criterion', text: criterion.text})),
  concepts: concepts.map((concept) => ({_key: concept.conceptId, _type: 'reference', _ref: concept._id})),
  sourceChunkRefs,
  review: {instructionsClear: false, criteriaObservable: false, alternativesAllowed: false, sourcesSupport: false, conceptsRelevant: false},
}

const line = `${JSON.stringify(draft)}\n`
if (outPath) {
  await writeFile(outPath, line)
  console.log(`Wrote ${draft._id} (${sourceChunkRefs.length} source chunks, ${concepts.length} concepts) to ${outPath}. Nothing was written to Sanity.`)
} else {
  process.stdout.write(line)
}
