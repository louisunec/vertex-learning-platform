import {openai} from '@ai-sdk/openai'
import {auth} from '@clerk/nextjs/server'

import {AiCallError} from '@/lib/ai/gateway'
import {REVIEW_MODEL_ID} from '@/lib/ai/review'
import {isRetryableDatabaseError} from '@/lib/db/errors'
import {getDb} from '@/lib/db/client'
import {FLAGS, isFlagEnabled} from '@/lib/flags'
import {ContentUnavailableError} from '@/lib/learner/content-source'
import {learnerError, learnerJson, readBoundedJson} from '@/lib/learner/http'
import {REVIEW_MAX_BODY_BYTES, reviewRequestSchema} from '@/lib/submissions/contracts'
import {sanitySubmissionTaskSource} from '@/lib/submissions/sanity-source'
import {requestReviewHelp, submitForReview} from '@/lib/submissions/service'

/**
 * Reviews a learner's code against a published task, or gives more help on a
 * stored review (development plan §5 PR-12). Signed-in only; the learner id
 * and the help level are server-derived, and the strict body rejects any
 * client claim to either. Behind `learner-evidence`, `help-policy`, and
 * `submission-review`: any of them off means 404 before any content or
 * database access. A provider or content outage is a retryable 503, never
 * an empty review; the learner's code is theirs to resend.
 */
export async function POST(request: Request) {
  const {userId} = await auth()
  if (!userId) return learnerError('unauthenticated')
  for (const flag of [FLAGS.learnerEvidence, FLAGS.helpPolicy, FLAGS.submissionReview]) {
    if (!(await isFlagEnabled(flag, userId))) return learnerError('not_found')
  }

  const body = await readBoundedJson(request, REVIEW_MAX_BODY_BYTES)
  if (!body.ok) return learnerError(body.code)
  const parsed = reviewRequestSchema.safeParse(body.value)
  if (!parsed.success) return learnerError('invalid_request')

  try {
    const outcome =
      parsed.data.action === 'review'
        ? await submitForReview({
            db: getDb(),
            source: sanitySubmissionTaskSource,
            model: process.env.OPENAI_API_KEY ? openai(REVIEW_MODEL_ID) : null,
            learnerId: userId,
            request: parsed.data,
          })
        : await requestReviewHelp({db: getDb(), source: sanitySubmissionTaskSource, learnerId: userId, request: parsed.data})
    if (outcome.status === 'rejected') return learnerError(outcome.code)
    return outcome.replayed ? learnerJson(outcome.body, 200, {'Idempotent-Replayed': 'true'}) : learnerJson(outcome.body, 201)
  } catch (error) {
    return reviewFailure(error)
  }
}

/**
 * Like `failureResponse`, but logs only the failure's class: a provider,
 * validation, or database error can quote the learner's code, which never
 * goes to logs (development plan §3).
 */
function reviewFailure(error: unknown): Response {
  const name = error instanceof Error ? error.name : typeof error
  if (error instanceof AiCallError) {
    console.error(`[review] unavailable: model ${error.category}`)
    return learnerError('unavailable')
  }
  if (error instanceof ContentUnavailableError || isRetryableDatabaseError(error)) {
    console.error(`[review] unavailable: ${name}`)
    return learnerError('unavailable')
  }
  console.error(`[review] failed: ${name}`)
  return learnerError('internal_error')
}
