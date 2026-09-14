import type {EvidenceChunk} from '../ai/tutor.ts'
import {hashParts} from '../evidence/chunks.ts'
import type {LearnerExplainTaskView} from './contracts.ts'

/**
 * A published explanation task as the server uses it (development plan §5
 * PR-8): the learner-visible prompt, and the private rubric with each
 * criterion's concept, objective, and course sources at the revisions an
 * editor reviewed. Framework-free.
 */

export type TaskConcept = {conceptId: string; name: string}

export type ExplainCriterion = {
  /** The criterion's array `_key`; stable within a task version. */
  id: string
  /** Learner-facing topic, shown after feedback; never states the point. */
  label: string
  /** What an accurate explanation conveys. Private: only the model and the server see it. */
  point: string
  required: boolean
  concept: TaskConcept
  /** A `_key` of the concept's objectives, when the editor tied the point to one. */
  objectiveKey: string | null
  /** This criterion's reviewed sources, a subset of the task's evidence, in time order. */
  sources: EvidenceChunk[]
}

export type ExplainTask = {
  documentId: string
  taskId: string
  version: number
  title: string
  prompt: string
  criteria: ExplainCriterion[]
  /** Approved concepts named by the criteria, in criterion order. */
  concepts: TaskConcept[]
  lesson: {id: string; title: string; slug: string}
  /** The task's source chunks, each still at its reviewed revision, in time order. */
  evidence: EvidenceChunk[]
  /** Changes whenever the criteria or their sources change (stored as `rubric_version`). */
  rubricHash: string
  /** Changes whenever anything an evaluation depends on changes (cache scope). */
  taskHash: string
}

/**
 * `none`: the lesson has no servable task. `stale`: it has one, but a
 * source or concept it relies on changed since review, so it is withheld
 * until an editor re-drafts it. Neither is a judgment about the learner.
 */
export type LoadedTask = {status: 'ok'; task: ExplainTask} | {status: 'none'} | {status: 'stale'}

type Hashable = Omit<ExplainTask, 'rubricHash' | 'taskHash'>

export function rubricHashOf(task: Pick<Hashable, 'criteria'>): string {
  return hashParts([
    'explanation-rubric-v1',
    ...task.criteria.flatMap((criterion) => [
      '|criterion',
      criterion.id,
      criterion.label,
      criterion.point,
      criterion.required ? 'required' : 'optional',
      criterion.concept.conceptId,
      criterion.objectiveKey ?? '',
      ...criterion.sources.flatMap((chunk) => [chunk.chunkId, chunk.chunkRevision]),
    ]),
  ])
}

export function taskHashOf(task: Hashable): string {
  return hashParts([
    'explanation-task-v1',
    task.documentId,
    task.taskId,
    String(task.version),
    task.lesson.id,
    task.title,
    task.prompt,
    rubricHashOf(task),
    '|evidence',
    ...task.evidence.flatMap((chunk) => [chunk.chunkId, chunk.chunkRevision]),
  ])
}

export function withHashes(task: Hashable): ExplainTask {
  return {...task, rubricHash: rubricHashOf(task), taskHash: taskHashOf(task)}
}

export function toLearnerTaskView(task: ExplainTask): LearnerExplainTaskView {
  return {lessonId: task.lesson.id, taskId: task.taskId, version: task.version, title: task.title, prompt: task.prompt}
}

/** Serializes a learner's explanations of one task (any version), so the history read when classifying is never stale. */
export const explanationLockKey = (taskId: string) => `explanation-task:${taskId}`
