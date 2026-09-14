import {auth} from '@clerk/nextjs/server'

import {getDb} from '@/lib/db/client'
import {isNextActionEnabled, nextActionCapabilities} from '@/lib/flags'
import {failureResponse, learnerError, learnerJson, readBoundedJson} from '@/lib/learner/http'
import {planNextActions} from '@/lib/learner/next-action'
import {sanityNextActionContent} from '@/lib/learner/next-action-content'
import {nextActionRequestSchema} from '@/lib/learner/next-action-contracts'

/**
 * The signed-in learner's next actions (development plan §5 PR-11): a
 * short, ordered plan for their stored goal, or for another published
 * course named in the body (a preview; nothing is saved). The server
 * derives every item, reason, timestamp, and link from the learner's own
 * evidence and published content; the body names no learner. Read-only.
 * Signed-in only. Behind `next-action` and `learner-evidence`: either off
 * means 404 before any content or database access.
 */
export async function POST(request: Request) {
  const {userId} = await auth()
  if (!userId) return learnerError('unauthenticated')
  if (!(await isNextActionEnabled(userId))) return learnerError('not_found')

  const body = await readBoundedJson(request)
  if (!body.ok) return learnerError(body.code)
  const parsed = nextActionRequestSchema.safeParse(body.value)
  if (!parsed.success) return learnerError('invalid_request')

  try {
    const outcome = await planNextActions({
      db: getDb(),
      content: sanityNextActionContent,
      learnerId: userId,
      request: parsed.data,
      capabilities: await nextActionCapabilities(userId),
      now: new Date(),
    })
    if (outcome.status === 'rejected') return learnerError(outcome.code)
    return learnerJson(outcome.body)
  } catch (error) {
    return failureResponse('next', error)
  }
}
