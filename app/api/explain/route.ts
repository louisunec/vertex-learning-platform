import {openai} from '@ai-sdk/openai'
import {auth} from '@clerk/nextjs/server'

import {EXPLAIN_MODEL_ID} from '@/lib/ai/explain'
import {AiCallError} from '@/lib/ai/gateway'
import {isRetryableDatabaseError} from '@/lib/db/errors'
import {getDb} from '@/lib/db/client'
import {EXPLAIN_MAX_BODY_BYTES, explainRequestSchema} from '@/lib/explain/contracts'
import {sanityExplanationTaskSource} from '@/lib/explain/sanity-source'
import {submitExplanation} from '@/lib/explain/service'
import {FLAGS, isFlagEnabled} from '@/lib/flags'
import {ContentUnavailableError} from '@/lib/learner/content-source'
import {learnerError, learnerJson, readBoundedJson} from '@/lib/learner/http'

/**
 * Formative feedback on a learner's explanation of a published task
 * (development plan §5 PR-8). Signed-in only; the learner id is
 * server-derived, and the strict body rejects any client claim to identity,
 * status, score, or sources. Behind `learner-evidence` and `explain-back`:
 * either off means 404 before any content or database access. A provider or
 * content outage is a retryable 503, never an empty or negative result; the
 * text is kept, and a retry with the same key evaluates it.
 */
export async function POST(request: Request) {
  const {userId} = await auth()
  if (!userId) return learnerError('unauthenticated')
  for (const flag of [FLAGS.learnerEvidence, FLAGS.explainBack]) {
    if (!(await isFlagEnabled(flag, userId))) return learnerError('not_found')
  }

  const body = await readBoundedJson(request, EXPLAIN_MAX_BODY_BYTES)
  if (!body.ok) return learnerError(body.code)
  const parsed = explainRequestSchema.safeParse(body.value)
  if (!parsed.success) return learnerError('invalid_request')

  try {
    const outcome = await submitExplanation({
      db: getDb(),
      source: sanityExplanationTaskSource,
      model: process.env.OPENAI_API_KEY ? openai(EXPLAIN_MODEL_ID) : null,
      learnerId: userId,
      request: parsed.data,
    })
    if (outcome.status === 'rejected') return learnerError(outcome.code)
    return outcome.replayed ? learnerJson(outcome.body, 200, {'Idempotent-Replayed': 'true'}) : learnerJson(outcome.body, 201)
  } catch (error) {
    return explainFailure(error)
  }
}

/**
 * Like `failureResponse`, but logs only the failure's class: a provider,
 * validation, or database error can quote the learner's text, which never
 * goes to logs (development plan §3).
 */
function explainFailure(error: unknown): Response {
  const name = error instanceof Error ? error.name : typeof error
  if (error instanceof AiCallError) {
    console.error(`[explain] unavailable: model ${error.category}`)
    return learnerError('unavailable')
  }
  if (error instanceof ContentUnavailableError || isRetryableDatabaseError(error)) {
    console.error(`[explain] unavailable: ${name}`)
    return learnerError('unavailable')
  }
  console.error(`[explain] failed: ${name}`)
  return learnerError('internal_error')
}
