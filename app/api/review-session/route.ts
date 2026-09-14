import {auth} from '@clerk/nextjs/server'

import {getDb} from '@/lib/db/client'
import {isReviewEnabled, isScheduledReviewEnabled} from '@/lib/flags'
import {sanityLearnerContent} from '@/lib/learner/content'
import {reviewSessionRequestSchema} from '@/lib/learner/contracts'
import {failureResponse, learnerError, learnerJson, readBoundedJson} from '@/lib/learner/http'
import {startReviewSession} from '@/lib/learner/review-session'
import {startScheduledReview} from '@/lib/learner/scheduled-review'

/**
 * Starts or resumes the signed-in learner's review. The body names only the
 * mode: `mistakes` (the default, prompts/focused-review.md) chooses from the
 * learner's own recent mistakes; `scheduled` (PR-9,
 * prompts/pr-9-scheduled-review.md) serves their due review cards. Either
 * way the server chooses every question from published, approved content.
 * Answers go to `/api/attempts` and hints to `/api/help`, and progress is
 * read back from the stored attempts. Signed-in only. Behind
 * `learner-evidence` and `review-session`, plus `scheduled-review` for the
 * scheduled mode: a flag that's off means 404 before any content or database
 * access.
 */
export async function POST(request: Request) {
  const {userId} = await auth()
  if (!userId) return learnerError('unauthenticated')
  if (!(await isReviewEnabled(userId))) return learnerError('not_found')

  const body = await readBoundedJson(request)
  if (!body.ok) return learnerError(body.code)
  const parsed = reviewSessionRequestSchema.safeParse(body.value)
  if (!parsed.success) return learnerError('invalid_request')
  const scheduled = parsed.data.mode === 'scheduled'
  if (scheduled && !(await isScheduledReviewEnabled(userId))) return learnerError('not_found')

  try {
    const args = {db: getDb(), content: sanityLearnerContent, learnerId: userId, now: new Date()}
    const session = scheduled ? await startScheduledReview(args) : await startReviewSession(args)
    return learnerJson(session, session.status === 'active' && !session.resumed ? 201 : 200)
  } catch (error) {
    return failureResponse('review-session', error)
  }
}
