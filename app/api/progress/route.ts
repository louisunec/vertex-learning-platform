import {auth} from '@clerk/nextjs/server'

import {failureResponse, learnerError, learnerJson, readBoundedJson} from '@/lib/learner/http'
import {MAX_PROGRESS_BODY_BYTES, saveProgress, saveProgressRequestSchema} from '@/lib/progress/save'
import {sanityProgressStore} from '@/lib/progress/store'
import {ProgressWriterUnavailableError} from '@/sanity/lib/learner-client'

/**
 * Saves the signed-in learner's resume position and completion for one
 * published lesson. The learner id comes only from the session; the body
 * names the lesson and position, never the user. Completion is never cleared.
 */
export async function POST(request: Request) {
  const {userId} = await auth()
  if (!userId) return learnerError('unauthenticated')

  const body = await readBoundedJson(request, MAX_PROGRESS_BODY_BYTES)
  if (!body.ok) return learnerError(body.code)
  const parsed = saveProgressRequestSchema.safeParse(body.value)
  if (!parsed.success) return learnerError('invalid_request')

  try {
    const outcome = await saveProgress({store: sanityProgressStore, userId, request: parsed.data, now: new Date()})
    if (outcome.status === 'not_found') return learnerError('not_found')
    return learnerJson(outcome)
  } catch (error) {
    if (error instanceof ProgressWriterUnavailableError) {
      console.error('[progress] unavailable:', error.message)
      return learnerError('unavailable')
    }
    return failureResponse('progress', error)
  }
}
