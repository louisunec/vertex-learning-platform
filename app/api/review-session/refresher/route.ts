import {auth} from '@clerk/nextjs/server'

import {getDb} from '@/lib/db/client'
import {isReviewEnabled} from '@/lib/flags'
import {sanityLearnerContent} from '@/lib/learner/content'
import {reviewRefresherRequestSchema} from '@/lib/learner/contracts'
import {failureResponse, learnerError, learnerJson, readBoundedJson} from '@/lib/learner/http'
import {openRefresher} from '@/lib/learner/review-session'

/**
 * The lesson moment a review question cites (`/lessons/<slug>?t=<seconds>`),
 * recorded first as help on that question, so an answer given after watching
 * it counts as assisted. Only questions of the learner's own review sessions
 * have one. Idempotent by `requestKey`. Signed-in only; behind
 * `learner-evidence` and `review-session`.
 */
export async function POST(request: Request) {
  const {userId} = await auth()
  if (!userId) return learnerError('unauthenticated')
  if (!(await isReviewEnabled(userId))) return learnerError('not_found')

  const body = await readBoundedJson(request)
  if (!body.ok) return learnerError(body.code)
  const parsed = reviewRefresherRequestSchema.safeParse(body.value)
  if (!parsed.success) return learnerError('invalid_request')

  try {
    const outcome = await openRefresher({db: getDb(), content: sanityLearnerContent, learnerId: userId, request: parsed.data})
    if (outcome.status === 'rejected') return learnerError(outcome.code)
    return learnerJson(outcome.body, outcome.body.replayed ? 200 : 201, outcome.body.replayed ? {'Idempotent-Replayed': 'true'} : {})
  } catch (error) {
    return failureResponse('review-refresher', error)
  }
}
