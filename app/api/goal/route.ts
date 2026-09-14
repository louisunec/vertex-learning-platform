import {auth} from '@clerk/nextjs/server'

import {getDb} from '@/lib/db/client'
import {isNextActionEnabled} from '@/lib/flags'
import {setLearningGoal} from '@/lib/learner/goal'
import {failureResponse, learnerError, learnerJson, readBoundedJson} from '@/lib/learner/http'
import {sanityNextActionContent} from '@/lib/learner/next-action-content'
import {goalRequestSchema} from '@/lib/learner/next-action-contracts'

/**
 * Sets the signed-in learner's current learning goal to a published course
 * they chose (development plan §5 PR-11). A goal is only ever saved by this
 * explicit request; nothing infers one. Signed-in only. Behind
 * `next-action` and `learner-evidence`: either off means 404 before any
 * content or database access.
 */
export async function POST(request: Request) {
  const {userId} = await auth()
  if (!userId) return learnerError('unauthenticated')
  if (!(await isNextActionEnabled(userId))) return learnerError('not_found')

  const body = await readBoundedJson(request)
  if (!body.ok) return learnerError(body.code)
  const parsed = goalRequestSchema.safeParse(body.value)
  if (!parsed.success) return learnerError('invalid_request')

  try {
    const outcome = await setLearningGoal({
      db: getDb(),
      content: sanityNextActionContent,
      learnerId: userId,
      request: parsed.data,
      now: new Date(),
    })
    if (outcome.status === 'rejected') return learnerError(outcome.code)
    return learnerJson(outcome.body)
  } catch (error) {
    return failureResponse('goal', error)
  }
}
