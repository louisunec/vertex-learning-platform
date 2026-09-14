import type {EvidenceChunk} from '../ai/tutor.ts'
import {hashParts} from '../evidence/chunks.ts'
import type {LearnerTaskView, SubmissionLanguage} from './contracts.ts'

/**
 * A published submission task as the server uses it (development plan §5
 * PR-12): the learner-visible task plus its concepts and the resolved course
 * evidence at the revisions an editor reviewed. Framework-free.
 */

export type TaskConcept = {conceptId: string; name: string}

export type SubmissionTask = {
  documentId: string
  taskId: string
  version: number
  title: string
  instructions: string
  language: SubmissionLanguage
  criteria: Array<{id: string; text: string}>
  /** Approved concepts only. */
  concepts: TaskConcept[]
  lesson: {id: string; title: string; slug: string}
  /** The task's source chunks, each still at its reviewed revision. */
  evidence: EvidenceChunk[]
  /** Changes whenever anything a review depends on changes (cache and help scope). */
  taskHash: string
}

/**
 * `none`: the lesson has no servable task. `stale`: it has one, but a
 * source it cites changed or disappeared since review, so it is withheld
 * until an editor re-resolves it.
 */
export type LoadedTask = {status: 'ok'; task: SubmissionTask} | {status: 'none'} | {status: 'stale'}

export function taskHashOf(task: Omit<SubmissionTask, 'taskHash'>): string {
  return hashParts([
    'submission-task-v1',
    task.documentId,
    task.taskId,
    String(task.version),
    task.lesson.id,
    task.title,
    task.instructions,
    task.language,
    ...task.criteria.flatMap((criterion) => [criterion.id, criterion.text]),
    '|concepts',
    ...task.concepts.map((concept) => concept.conceptId),
    '|evidence',
    ...task.evidence.flatMap((chunk) => [chunk.chunkId, chunk.chunkRevision]),
  ])
}

export function toLearnerTaskView(task: SubmissionTask): LearnerTaskView {
  return {
    lessonId: task.lesson.id,
    taskId: task.taskId,
    version: task.version,
    title: task.title,
    instructions: task.instructions,
    language: task.language,
    criteria: task.criteria.map(({id, text}) => ({id, text})),
  }
}

/**
 * `help_event` scopes. The help policy counts levels per review (`session_id`):
 * new code gets its own ladder from level 1, while unchanged code reuses its
 * review and the level already reached. Evidence counts assistance per task
 * across versions (`family_id`), so a fix after any help stays assisted.
 * Tutor session ids cannot contain `:`, so neither collides.
 */
export const helpSessionKey = (reviewId: string) => `submission-review:${reviewId}`
export const helpFamilyKey = (taskId: string) => `submission-task:${taskId}`
