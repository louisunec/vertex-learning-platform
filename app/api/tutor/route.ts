import {openai} from '@ai-sdk/openai'
import {auth} from '@clerk/nextjs/server'

import {TUTOR_MODEL_ID} from '@/lib/ai/tutor'
import {getDb} from '@/lib/db/client'
import {FLAGS, isFlagEnabled} from '@/lib/flags'
import {tutorRequestSchema} from '@/lib/learner/contracts'
import {failureResponse, learnerError, learnerJson, readBoundedJson} from '@/lib/learner/http'
import {sanityTutorSource} from '@/lib/tutor/sanity-source'
import {askTutor} from '@/lib/tutor/service'

/**
 * Answers a question about a lesson from its time-anchored course sources
 * (development plan §5 PR-6). Signed-in only; the learner id and the help
 * level are server-derived, and citations are built from stored records.
 * Behind `learner-evidence`, `help-policy`, and `tutor`: any of them off
 * means 404 before any content or database access. A provider or content
 * outage is a retryable 503, never "not covered".
 */
export async function POST(request: Request) {
  const {userId} = await auth()
  if (!userId) return learnerError('unauthenticated')
  for (const flag of [FLAGS.learnerEvidence, FLAGS.helpPolicy, FLAGS.tutor]) {
    if (!(await isFlagEnabled(flag, userId))) return learnerError('not_found')
  }

  const body = await readBoundedJson(request)
  if (!body.ok) return learnerError(body.code)
  const parsed = tutorRequestSchema.safeParse(body.value)
  if (!parsed.success) return learnerError('invalid_request')

  try {
    const outcome = await askTutor({
      db: getDb(),
      source: sanityTutorSource,
      model: process.env.OPENAI_API_KEY ? openai(TUTOR_MODEL_ID) : null,
      learnerId: userId,
      request: parsed.data,
    })
    if (outcome.status === 'rejected') return learnerError(outcome.code)
    return learnerJson(outcome.body, 201)
  } catch (error) {
    return failureResponse('tutor', error)
  }
}
