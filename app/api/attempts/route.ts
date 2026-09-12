import {auth} from '@clerk/nextjs/server'

import {getDb} from '@/lib/db/client'
import {FLAGS, isFlagEnabled} from '@/lib/flags'
import {submitAttempt} from '@/lib/learner/attempts'
import {sanityLearnerContent} from '@/lib/learner/content'
import {submitAttemptRequestSchema} from '@/lib/learner/contracts'
import {failureResponse, learnerError, learnerJson, readBoundedJson} from '@/lib/learner/http'

/**
 * Grades one submission for a server-issued task instance (development plan
 * §5 PR-4). Signed-in only; the learner id, grade, and help level are all
 * server-derived, and the strict body schema rejects any client claim to
 * them. Idempotent: replaying a key with the same body returns the stored
 * result (`Idempotent-Replayed: true`) without adding evidence. Behind the
 * `learner-evidence` flag.
 */
export async function POST(request: Request) {
  const {userId} = await auth()
  if (!userId) return learnerError('unauthenticated')
  if (!(await isFlagEnabled(FLAGS.learnerEvidence, userId))) return learnerError('not_found')

  const body = await readBoundedJson(request)
  if (!body.ok) return learnerError(body.code)
  const parsed = submitAttemptRequestSchema.safeParse(body.value)
  if (!parsed.success) return learnerError('invalid_request')

  try {
    const outcome = await submitAttempt({
      db: getDb(),
      content: sanityLearnerContent,
      learnerId: userId,
      request: parsed.data,
      now: new Date(),
    })
    if (outcome.status === 'rejected') return learnerError(outcome.code)
    return outcome.replayed
      ? learnerJson(outcome.body, 200, {'Idempotent-Replayed': 'true'})
      : learnerJson(outcome.body, 201)
  } catch (error) {
    return failureResponse('attempts', error)
  }
}
