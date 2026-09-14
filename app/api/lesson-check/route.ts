import {auth} from '@clerk/nextjs/server'

import {getDb} from '@/lib/db/client'
import {FLAGS, isFlagEnabled} from '@/lib/flags'
import {sanityLearnerContent} from '@/lib/learner/content'
import {lessonCheckRequestSchema} from '@/lib/learner/contracts'
import {failureResponse, learnerError, learnerJson, readBoundedJson} from '@/lib/learner/http'
import {nextLessonTask} from '@/lib/learner/lesson-check'

/**
 * Issues the next question of a lesson's understanding check, or an unseen
 * same-concept variant after an answered one (development plan §5 PR-7). The
 * server chooses the item from published, approved content and the learner's
 * own history; the response carries only the learner-safe item. Signed-in
 * only. Behind `learner-evidence` and `lesson-integration`: either off means
 * 404 before any content or database access.
 */
export async function POST(request: Request) {
  const {userId} = await auth()
  if (!userId) return learnerError('unauthenticated')
  for (const flag of [FLAGS.learnerEvidence, FLAGS.lessonIntegration]) {
    if (!(await isFlagEnabled(flag, userId))) return learnerError('not_found')
  }

  const body = await readBoundedJson(request)
  if (!body.ok) return learnerError(body.code)
  const parsed = lessonCheckRequestSchema.safeParse(body.value)
  if (!parsed.success) return learnerError('invalid_request')

  try {
    const outcome = await nextLessonTask({
      db: getDb(),
      content: sanityLearnerContent,
      learnerId: userId,
      request: parsed.data,
      now: new Date(),
    })
    if (outcome.status === 'rejected') return learnerError(outcome.code)
    return learnerJson(outcome.body, outcome.body.status === 'issued' && !outcome.body.resumed ? 201 : 200)
  } catch (error) {
    return failureResponse('lesson-check', error)
  }
}
