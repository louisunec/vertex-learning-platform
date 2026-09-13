import 'server-only'

import {FLAGS, isFlagEnabled} from '@/lib/flags'
import {sanityLearnerContent} from '@/lib/learner/content'

import {decideLessonFeatures, type LessonFeatures} from './features'

/**
 * The lesson page's learning features for a signed-in learner, or null when
 * none render. `lesson-integration` is evaluated first so the usual rollout
 * state costs one flag check; the item count is a published-content read
 * only — no database access happens while the page renders. A failed count
 * hides the check rather than failing the page.
 */
export async function resolveLessonFeatures({
  userId,
  lessonId,
  provider,
}: {
  userId: string
  lessonId: string
  provider: string | null
}): Promise<LessonFeatures | null> {
  if (!(await isFlagEnabled(FLAGS.lessonIntegration, userId))) return null
  const [learnerEvidence, helpPolicy, tutor] = await Promise.all([
    isFlagEnabled(FLAGS.learnerEvidence, userId),
    isFlagEnabled(FLAGS.helpPolicy, userId),
    isFlagEnabled(FLAGS.tutor, userId),
  ])
  if (!learnerEvidence) return null

  let checkItems = 0
  try {
    checkItems = (await sanityLearnerContent.loadLessonCheckCandidates(lessonId)).length
  } catch (error) {
    console.warn('[lesson] check items unavailable; hiding the check:', error instanceof Error ? error.message : error)
  }

  const features = decideLessonFeatures({
    flags: {lessonIntegration: true, learnerEvidence, helpPolicy, tutor},
    provider,
    checkItems,
  })
  return features.check || features.tutor ? features : null
}
