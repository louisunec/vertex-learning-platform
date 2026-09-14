import type {SanityDocument} from 'sanity'

import {SUBMISSION_TASK_CONTENT_FIELDS, SUBMISSION_TASK_REVIEW_CHECKS} from '../schemaTypes/documents/submission-task'
import {contentChanged} from './assessment-publish'

/**
 * Editorial gate on publishing submission tasks (development plan §5 PR-12),
 * the concept revision rule: a task keeps its id and lesson, starts at
 * version 1, and its version increases by exactly one when published content
 * changes, and only then, so reviews stored against a version stay tied to
 * what the learner was shown. Approval needs every review check; archiving
 * withdraws the task from learners.
 */
export function submissionTaskPublishBlockReason(draft: SanityDocument | null, published: SanityDocument | null): string | null {
  if (!draft) return null
  if (published && draft.taskId !== published.taskId) return 'A task keeps its id. Draft a new task instead.'

  const changed = published ? contentChanged(draft, published, SUBMISSION_TASK_CONTENT_FIELDS) : false
  const publishedVersion = Number(published?.version ?? 1)
  if (!published && draft.version !== 1) return 'A new task starts at version 1.'
  if (published && changed && draft.version !== publishedVersion + 1) {
    return `Content changed since version ${publishedVersion}: set the version to ${publishedVersion + 1}.`
  }
  if (published && !changed && draft.version !== publishedVersion) return `Keep version ${publishedVersion}: only a content change increases it.`

  if (draft.reviewStatus === 'archived') return changed ? 'An archived task keeps its published content.' : null
  if (draft.reviewStatus !== 'approved') return 'Set the review status to Approved before publishing.'
  const review = (draft.review ?? {}) as Record<string, unknown>
  return SUBMISSION_TASK_REVIEW_CHECKS.every((check) => review[check.name] === true) ? null : 'Complete every review check before publishing.'
}
