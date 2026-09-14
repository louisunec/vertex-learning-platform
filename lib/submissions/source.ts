import {z} from 'zod'

import type {EvidenceChunk} from '../ai/tutor.ts'
import {chunkRevisionOf} from '../evidence/chunks.ts'
import {MAX_CHUNK_SECONDS} from '../video/ingest.ts'
import {parseVideoUrl} from '../video/provider.ts'
import {criterionIdSchema, MAX_CRITERIA, SUBMISSION_LANGUAGES, taskIdSchema} from './contracts.ts'
import {taskHashOf, type LoadedTask, type TaskConcept} from './task.ts'

/**
 * Published submission tasks (development plan §5 PR-12) behind a port, so
 * the service runs on fixtures in tests and on the Sanity HTTP API in the
 * offline evaluation; the web app's implementation is `sanity-source.ts`.
 *
 * Both queries are parameterized. Only the task's own chunks are read, by
 * key, never a whole transcript. Draft and release ids are excluded on top of
 * the published perspective, and a task counts only while its lesson is
 * published. A cited chunk whose text or start changed since the editor
 * reviewed the task makes the task `stale`.
 */

export type SubmissionTaskSource = {
  /** The lesson's first approved task (by `taskId`), resolved, or why there is none. */
  loadLessonTask(lessonId: string): Promise<LoadedTask>
}

export const MAX_TASK_SOURCES = 8
export const MAX_TASK_CONCEPTS = 4

const PUBLISHED = /* groq */ `!(_id in path("drafts.**")) && !(_id in path("versions.**"))`

export const LESSON_TASK_QUERY = /* groq */ `
  *[
    _type == "submissionTask" &&
    lesson._ref == $lessonId &&
    reviewStatus == "approved" &&
    ${PUBLISHED} &&
    lesson->_type == "lesson"
  ] | order(taskId asc)[0] {
    _id,
    taskId,
    version,
    title,
    instructions,
    language,
    "criteria": criteria[0...${MAX_CRITERIA}] { "id": _key, text },
    "concepts": concepts[0...${MAX_TASK_CONCEPTS}]-> { conceptId, name, reviewStatus },
    "sourceChunkRefs": sourceChunkRefs[0...${MAX_TASK_SOURCES}] { chunkId, chunkRevision, startSeconds, endSeconds },
    "lesson": lesson-> { _id, title, "slug": slug.current, videoUrl }
  }
`

export const TASK_CHUNKS_QUERY = /* groq */ `
  *[_type == "video" && _id == $videoDocumentId && ${PUBLISHED}][0] {
    videoId,
    "chunks": transcriptChunks[_key in $keys][0...${MAX_TASK_SOURCES}] { _key, startSeconds, text }
  }
`

const publishedId = z.string().refine((id) => !id.startsWith('drafts.') && !id.startsWith('versions.'))
const seconds = z.number().int().nonnegative()

const taskRowSchema = z.object({
  _id: publishedId,
  taskId: taskIdSchema,
  version: z.number().int().min(1),
  title: z.string().trim().min(1).max(120),
  instructions: z.string().trim().min(1).max(2000),
  language: z.enum(SUBMISSION_LANGUAGES),
  criteria: z
    .array(z.object({id: criterionIdSchema, text: z.string().trim().min(1).max(300)}))
    .min(1)
    .max(MAX_CRITERIA)
    .refine((criteria) => new Set(criteria.map((criterion) => criterion.id)).size === criteria.length),
  concepts: z.array(z.unknown()).nullish(),
  sourceChunkRefs: z
    .array(z.object({chunkId: z.string().min(3).max(200), chunkRevision: z.string().min(1).max(64), startSeconds: seconds, endSeconds: seconds}))
    .min(1)
    .max(MAX_TASK_SOURCES),
  lesson: z.object({_id: publishedId, title: z.string().min(1), slug: z.string().min(1), videoUrl: z.string().nullish()}),
})

const conceptRowSchema = z.object({conceptId: z.string().min(1).max(128), name: z.string().trim().min(1).max(200), reviewStatus: z.literal('approved')})

const chunksRowSchema = z.object({
  videoId: z.string().min(1),
  chunks: z.array(z.object({_key: z.string().min(1), startSeconds: seconds, text: z.string()})).nullish(),
})

const videoDocumentOf = (chunkId: string) => chunkId.slice(0, chunkId.lastIndexOf(':'))
const chunkKeyOf = (chunkId: string) => chunkId.slice(chunkId.lastIndexOf(':') + 1)

/** A `SubmissionTaskSource` over any published-perspective GROQ executor. */
export function createGroqSubmissionTaskSource(groq: (query: string, params: Record<string, unknown>) => Promise<unknown>): SubmissionTaskSource {
  return {
    async loadLessonTask(lessonId) {
      const raw = await groq(LESSON_TASK_QUERY, {lessonId})
      if (raw === null || raw === undefined) return {status: 'none'}
      const row = taskRowSchema.safeParse(raw)
      // A malformed approved task is withheld, never repaired.
      if (!row.success) return {status: 'none'}
      const task = row.data

      // Every source must be a chunk of this lesson's own video.
      const video = parseVideoUrl(task.lesson.videoUrl)
      const videoDocumentId = video?.documentId ?? null
      if (!videoDocumentId || task.sourceChunkRefs.some((ref) => videoDocumentOf(ref.chunkId) !== videoDocumentId)) return {status: 'stale'}

      const chunks = chunksRowSchema.safeParse(
        await groq(TASK_CHUNKS_QUERY, {videoDocumentId, keys: task.sourceChunkRefs.map((ref) => chunkKeyOf(ref.chunkId))}),
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

      const concepts: TaskConcept[] = []
      for (const candidate of task.concepts ?? []) {
        const concept = conceptRowSchema.safeParse(candidate)
        if (concept.success && !concepts.some((known) => known.conceptId === concept.data.conceptId)) {
          concepts.push({conceptId: concept.data.conceptId, name: concept.data.name})
        }
      }

      const resolved = {
        documentId: task._id,
        taskId: task.taskId,
        version: task.version,
        title: task.title,
        instructions: task.instructions,
        language: task.language,
        criteria: task.criteria,
        concepts,
        lesson: {id: task.lesson._id, title: task.lesson.title, slug: task.lesson.slug},
        evidence: evidence.toSorted((a, b) => a.startSeconds - b.startSeconds),
      }
      return {status: 'ok', task: {...resolved, taskHash: taskHashOf(resolved)}}
    },
  }
}
