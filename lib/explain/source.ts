import {z} from 'zod'

import type {EvidenceChunk} from '../ai/tutor.ts'
import {chunkRevisionOf} from '../evidence/chunks.ts'
import {MAX_CHUNK_SECONDS} from '../video/ingest.ts'
import {parseVideoUrl} from '../video/provider.ts'
import {criterionIdSchema, MAX_CRITERIA, MAX_LABEL_LENGTH, taskIdSchema} from './contracts.ts'
import {withHashes, type ExplainCriterion, type LoadedTask, type TaskConcept} from './task.ts'

/**
 * Published explanation tasks (development plan §5 PR-8) behind a port, so
 * the service runs on fixtures in tests and on the Sanity HTTP API in the
 * offline evaluation; the web app's implementation is `sanity-source.ts`.
 *
 * Both queries are parameterized. Only the task's own chunks are read, by
 * key, never a whole transcript. Draft and release ids are excluded on top
 * of the published perspective, and a task counts only while its lesson is
 * published. A cited chunk whose text or start changed since review, or a
 * criterion concept that is no longer approved, makes the task `stale`.
 */

export type ExplanationTaskSource = {
  /** The lesson's first approved task (by `taskId`), resolved, or why there is none. */
  loadLessonTask(lessonId: string): Promise<LoadedTask>
}

export const MAX_TASK_SOURCES = 10
export const MAX_CRITERION_SOURCES = 6

const PUBLISHED = /* groq */ `!(_id in path("drafts.**")) && !(_id in path("versions.**"))`

export const LESSON_EXPLANATION_TASK_QUERY = /* groq */ `
  *[
    _type == "explanationTask" &&
    lesson._ref == $lessonId &&
    reviewStatus == "approved" &&
    ${PUBLISHED} &&
    lesson->_type == "lesson"
  ] | order(taskId asc)[0] {
    _id,
    taskId,
    version,
    title,
    prompt,
    "criteria": criteria[0...${MAX_CRITERIA}] {
      "id": _key,
      label,
      point,
      required,
      objectiveKey,
      sourceChunkIds,
      "concept": concept-> { _id, conceptId, name, reviewStatus, "objectiveKeys": objectives[]._key }
    },
    "sourceChunkRefs": sourceChunkRefs[0...${MAX_TASK_SOURCES}] { chunkId, chunkRevision, startSeconds, endSeconds },
    "lesson": lesson-> { _id, title, "slug": slug.current, videoUrl }
  }
`

export const EXPLANATION_TASK_CHUNKS_QUERY = /* groq */ `
  *[_type == "video" && _id == $videoDocumentId && ${PUBLISHED}][0] {
    videoId,
    "chunks": transcriptChunks[_key in $keys][0...${MAX_TASK_SOURCES}] { _key, startSeconds, text }
  }
`

const publishedId = z.string().refine((id) => !id.startsWith('drafts.') && !id.startsWith('versions.'))
const seconds = z.number().int().nonnegative()

const conceptRowSchema = z.object({
  _id: publishedId,
  conceptId: z.string().min(1).max(128),
  name: z.string().trim().min(1).max(200),
  reviewStatus: z.string(),
  objectiveKeys: z.array(z.string()).nullish(),
})

const criterionRowSchema = z.object({
  id: criterionIdSchema,
  label: z.string().trim().min(1).max(MAX_LABEL_LENGTH),
  point: z.string().trim().min(1).max(400),
  required: z.boolean(),
  objectiveKey: z.string().min(1).max(64).nullish(),
  sourceChunkIds: z.array(z.string().min(3).max(200)).min(1).max(MAX_CRITERION_SOURCES),
  // Parsed separately: a withdrawn concept makes the task stale, not malformed.
  concept: z.unknown(),
})

const taskRowSchema = z.object({
  _id: publishedId,
  taskId: taskIdSchema,
  version: z.number().int().min(1),
  title: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(600),
  criteria: z
    .array(criterionRowSchema)
    .min(1)
    .max(MAX_CRITERIA)
    .refine((criteria) => new Set(criteria.map((criterion) => criterion.id)).size === criteria.length)
    .refine((criteria) => criteria.some((criterion) => criterion.required)),
  sourceChunkRefs: z
    .array(z.object({chunkId: z.string().min(3).max(200), chunkRevision: z.string().min(1).max(64), startSeconds: seconds, endSeconds: seconds}))
    .min(1)
    .max(MAX_TASK_SOURCES),
  lesson: z.object({_id: publishedId, title: z.string().min(1), slug: z.string().min(1), videoUrl: z.string().nullish()}),
})

const chunksRowSchema = z.object({
  videoId: z.string().min(1),
  chunks: z.array(z.object({_key: z.string().min(1), startSeconds: seconds, text: z.string()})).nullish(),
})

const videoDocumentOf = (chunkId: string) => chunkId.slice(0, chunkId.lastIndexOf(':'))
const chunkKeyOf = (chunkId: string) => chunkId.slice(chunkId.lastIndexOf(':') + 1)

/** An `ExplanationTaskSource` over any published-perspective GROQ executor. */
export function createGroqExplanationTaskSource(groq: (query: string, params: Record<string, unknown>) => Promise<unknown>): ExplanationTaskSource {
  return {
    async loadLessonTask(lessonId) {
      const raw = await groq(LESSON_EXPLANATION_TASK_QUERY, {lessonId})
      if (raw === null || raw === undefined) return {status: 'none'}
      const row = taskRowSchema.safeParse(raw)
      // A malformed approved task is withheld, never repaired.
      if (!row.success) return {status: 'none'}
      const task = row.data

      // Every source must be a chunk of this lesson's own video, and every criterion source one of the task's.
      const video = parseVideoUrl(task.lesson.videoUrl)
      const videoDocumentId = video?.documentId ?? null
      if (!videoDocumentId || task.sourceChunkRefs.some((ref) => videoDocumentOf(ref.chunkId) !== videoDocumentId)) return {status: 'stale'}
      const taskChunkIds = new Set(task.sourceChunkRefs.map((ref) => ref.chunkId))
      if (task.criteria.some((criterion) => criterion.sourceChunkIds.some((id) => !taskChunkIds.has(id)))) return {status: 'none'}

      const chunks = chunksRowSchema.safeParse(
        await groq(EXPLANATION_TASK_CHUNKS_QUERY, {videoDocumentId, keys: task.sourceChunkRefs.map((ref) => chunkKeyOf(ref.chunkId))}),
      )
      if (!chunks.success || chunks.data.videoId !== video?.videoId) return {status: 'stale'}
      const byKey = new Map((chunks.data.chunks ?? []).map((chunk) => [chunk._key, chunk]))

      const evidence: EvidenceChunk[] = []
      for (const ref of task.sourceChunkRefs) {
        const chunk = byKey.get(chunkKeyOf(ref.chunkId))
        if (!chunk || chunk.startSeconds !== ref.startSeconds || chunkRevisionOf(chunk) !== ref.chunkRevision) return {status: 'stale'}
        if (evidence.some((earlier) => earlier.chunkId === ref.chunkId)) continue
        evidence.push({
          chunkId: ref.chunkId,
          chunkRevision: ref.chunkRevision,
          startSeconds: chunk.startSeconds,
          // The stored end came from the whole transcript when the task was drafted; keep it within one chunk.
          endSeconds: Math.min(Math.max(ref.endSeconds, chunk.startSeconds), chunk.startSeconds + MAX_CHUNK_SECONDS),
          text: chunk.text,
          lessonId: task.lesson._id,
          lessonTitle: task.lesson.title,
          lessonSlug: task.lesson.slug,
        })
      }
      evidence.sort((a, b) => a.startSeconds - b.startSeconds)
      const chunkById = new Map(evidence.map((chunk) => [chunk.chunkId, chunk]))

      const criteria: ExplainCriterion[] = []
      for (const criterion of task.criteria) {
        const concept = conceptRowSchema.safeParse(criterion.concept)
        // A criterion's concept must still be approved, and its objective still one of the concept's.
        if (!concept.success || concept.data.reviewStatus !== 'approved') return {status: 'stale'}
        const objectiveKey = criterion.objectiveKey ?? null
        if (objectiveKey && !(concept.data.objectiveKeys ?? []).includes(objectiveKey)) return {status: 'stale'}
        criteria.push({
          id: criterion.id,
          label: criterion.label,
          point: criterion.point,
          required: criterion.required,
          concept: {conceptId: concept.data.conceptId, name: concept.data.name},
          objectiveKey,
          sources: [...new Set(criterion.sourceChunkIds)].map((id) => chunkById.get(id)!).toSorted((a, b) => a.startSeconds - b.startSeconds),
        })
      }

      const concepts: TaskConcept[] = []
      for (const {concept} of criteria) {
        if (!concepts.some((known) => known.conceptId === concept.conceptId)) concepts.push(concept)
      }

      return {
        status: 'ok',
        task: withHashes({
          documentId: task._id,
          taskId: task.taskId,
          version: task.version,
          title: task.title,
          prompt: task.prompt,
          criteria,
          concepts,
          lesson: {id: task.lesson._id, title: task.lesson.title, slug: task.lesson.slug},
          evidence,
        }),
      }
    },
  }
}
