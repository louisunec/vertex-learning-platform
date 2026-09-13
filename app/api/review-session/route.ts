import {auth} from '@clerk/nextjs/server'

import {getDb} from '@/lib/db/client'
import {isReviewEnabled} from '@/lib/flags'
import {sanityLearnerContent} from '@/lib/learner/content'
import {reviewSessionRequestSchema} from '@/lib/learner/contracts'
import {failureResponse, learnerError, learnerJson, readBoundedJson} from '@/lib/learner/http'
import {startReviewSession} from '@/lib/learner/review-session'

/**
 * Starts or resumes the signed-in learner's focused review
 * (prompts/focused-review.md). The server chooses every question from the
 * learner's own recent mistakes and published, approved content; the body
 * names nothing. Answers go to `/api/attempts` and hints to `/api/help`, and
 * progress is read back from the stored attempts. Signed-in only. Behind
 * `learner-evidence` and `review-session`: either off means 404 before any
 * content or database access.
 */
export async function POST(request: Request) {
  const {userId} = await auth()
  if (!userId) return learnerError('unauthenticated')
  if (!(await isReviewEnabled(userId))) return learnerError('not_found')

  const body = await readBoundedJson(request)
  if (!body.ok) return learnerError(body.code)
  if (!reviewSessionRequestSchema.safeParse(body.value).success) return learnerError('invalid_request')

  try {
    const session = await startReviewSession({db: getDb(), content: sanityLearnerContent, learnerId: userId, now: new Date()})
    return learnerJson(session, session.status === 'active' && !session.resumed ? 201 : 200)
  } catch (error) {
    return failureResponse('review-session', error)
  }
}
