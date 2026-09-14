import 'server-only'

import {FLAGS, isFlagEnabled} from '@/lib/flags'

import type {LearnerExplainTaskView} from './contracts'
import {sanityExplanationTaskSource} from './sanity-source'
import {toLearnerTaskView} from './task'

/**
 * The lesson page's explain-back task for a signed-in learner, or null
 * (development plan §5 PR-8). Needs `explain-back` and `learner-evidence`,
 * evaluated in that order so the usual rollout state costs one check; it is
 * independent of `lesson-integration`, `help-policy`, and `tutor`. A
 * published-content read only: no database access while the page renders,
 * and a failed or stale read hides the step rather than failing the page.
 */
export async function resolveExplainTask({userId, lessonId}: {userId: string; lessonId: string}): Promise<LearnerExplainTaskView | null> {
  if (!(await isFlagEnabled(FLAGS.explainBack, userId))) return null
  if (!(await isFlagEnabled(FLAGS.learnerEvidence, userId))) return null
  try {
    const loaded = await sanityExplanationTaskSource.loadLessonTask(lessonId)
    return loaded.status === 'ok' ? toLearnerTaskView(loaded.task) : null
  } catch (error) {
    console.warn('[lesson] explanation task unavailable; hiding it:', error instanceof Error ? error.name : typeof error)
    return null
  }
}
