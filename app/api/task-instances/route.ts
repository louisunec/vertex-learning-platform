import {auth} from '@clerk/nextjs/server'

import {getDb} from '@/lib/db/client'
import {FLAGS, isFlagEnabled} from '@/lib/flags'
import {sanityLearnerContent} from '@/lib/learner/content'
import {issueTaskRequestSchema} from '@/lib/learner/contracts'
import {failureResponse, learnerError, learnerJson, readBoundedJson} from '@/lib/learner/http'
import {issueTask} from '@/lib/learner/task-instances'

/**
 * Issues a task instance for one published, approved, current assessment
 * (development plan §5 PR-4). Signed-in only; the learner id comes from the
 * session. Returns the learner-safe item — never its answer key or hints.
 * Behind the `learner-evidence` flag: off means 404 before any content or
 * database access.
 */
export async function POST(request: Request) {
  const {userId} = await auth()
  if (!userId) return learnerError('unauthenticated')
  if (!(await isFlagEnabled(FLAGS.learnerEvidence, userId))) return learnerError('not_found')

  const body = await readBoundedJson(request)
  if (!body.ok) return learnerError(body.code)
  const parsed = issueTaskRequestSchema.safeParse(body.value)
  if (!parsed.success) return learnerError('invalid_request')

  try {
    const outcome = await issueTask({
      db: getDb(),
      content: sanityLearnerContent,
      learnerId: userId,
      assessmentId: parsed.data.assessmentId,
      now: new Date(),
    })
    return outcome.status === 'issued' ? learnerJson(outcome.body, 201) : learnerError('not_found')
  } catch (error) {
    return failureResponse('task-instances', error)
  }
}
