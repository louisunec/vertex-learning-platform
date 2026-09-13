import {auth} from '@clerk/nextjs/server'

import {getDb} from '@/lib/db/client'
import {FLAGS, isFlagEnabled} from '@/lib/flags'
import {sanityLearnerContent} from '@/lib/learner/content'
import {helpRequestSchema} from '@/lib/learner/contracts'
import {requestHelp} from '@/lib/learner/help'
import {failureResponse, learnerError, learnerJson, readBoundedJson} from '@/lib/learner/http'

/**
 * Returns the reviewed hint the help policy decides for a server-issued task
 * instance (development plan §5 PR-5). Signed-in only; the learner id and
 * the help level are server-derived, and the strict body schema rejects any
 * client claim to a level or help history. Idempotent: replaying a request
 * key returns the stored level (`Idempotent-Replayed: true`) without
 * escalating. Behind both `learner-evidence` and `help-policy`: either off
 * means 404 before any content or database access.
 */
export async function POST(request: Request) {
  const {userId} = await auth()
  if (!userId) return learnerError('unauthenticated')
  if (!(await isFlagEnabled(FLAGS.learnerEvidence, userId))) return learnerError('not_found')
  if (!(await isFlagEnabled(FLAGS.helpPolicy, userId))) return learnerError('not_found')

  const body = await readBoundedJson(request)
  if (!body.ok) return learnerError(body.code)
  const parsed = helpRequestSchema.safeParse(body.value)
  if (!parsed.success) return learnerError('invalid_request')

  try {
    const outcome = await requestHelp({
      db: getDb(),
      content: sanityLearnerContent,
      learnerId: userId,
      request: parsed.data,
    })
    if (outcome.status === 'rejected') return learnerError(outcome.code)
    return outcome.replayed
      ? learnerJson(outcome.body, 200, {'Idempotent-Replayed': 'true'})
      : learnerJson(outcome.body, 201)
  } catch (error) {
    return failureResponse('help', error)
  }
}
