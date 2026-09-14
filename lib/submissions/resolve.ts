import 'server-only'

import {FLAGS, isFlagEnabled} from '@/lib/flags'

import type {LearnerTaskView} from './contracts'
import {sanitySubmissionTaskSource} from './sanity-source'
import {toLearnerTaskView} from './task'

/**
 * The lesson page's submission task for a signed-in learner, or null
 * (development plan §5 PR-12). Needs `submission-review`, `learner-evidence`,
 * and `help-policy`, evaluated in that order so the usual rollout state costs
 * one check; it is independent of `lesson-integration` and `tutor`. A
 * published-content read only: no database access while the page renders,
 * and a failed read hides the task rather than failing the page.
 */
export async function resolveSubmissionTask({userId, lessonId}: {userId: string; lessonId: string}): Promise<LearnerTaskView | null> {
  if (!(await isFlagEnabled(FLAGS.submissionReview, userId))) return null
  const [learnerEvidence, helpPolicy] = await Promise.all([
    isFlagEnabled(FLAGS.learnerEvidence, userId),
    isFlagEnabled(FLAGS.helpPolicy, userId),
  ])
  if (!learnerEvidence || !helpPolicy) return null
  try {
    const loaded = await sanitySubmissionTaskSource.loadLessonTask(lessonId)
    return loaded.status === 'ok' ? toLearnerTaskView(loaded.task) : null
  } catch (error) {
    console.warn('[lesson] submission task unavailable; hiding it:', error instanceof Error ? error.name : typeof error)
    return null
  }
}
