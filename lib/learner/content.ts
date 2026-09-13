import 'server-only'

import {toGradingItem, toConceptIndex} from '@/lib/assessments/grading'
import {toHintLadder} from '@/lib/assessments/hints'
import {toCheckCandidates, toLearnerAssessments} from '@/lib/assessments/learner'
import {CONTENT_REVALIDATE_SECONDS, sanityFetch} from '@/sanity/lib/fetch'
import {
  CONCEPT_NODES_QUERY,
  GRADING_ASSESSMENT_QUERY,
  HINT_LADDER_QUERY,
  LESSON_CHECK_CANDIDATES_QUERY,
  SERVABLE_ASSESSMENT_QUERY,
} from '@/sanity/queries/assessments'

import {ContentUnavailableError, type LearnerContentSource} from './content-source'

/**
 * Sanity-backed content for the learner-evidence routes, through the
 * published-perspective server client. Item reads are uncached so a
 * withdrawn or stale item stops being issued, graded, and hinted at once;
 * the concept graph uses the normal content revalidation.
 */

async function read<T>(label: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw new ContentUnavailableError(`${label} could not be read`, {cause: error})
  }
}

export const sanityLearnerContent: LearnerContentSource = {
  async loadServableItem(assessmentId) {
    const row = await read('Assessment', () =>
      sanityFetch({query: SERVABLE_ASSESSMENT_QUERY, params: {assessmentId}, revalidate: 0}),
    )
    return toLearnerAssessments(row ? [row] : [])[0] ?? null
  },

  async loadGradingItem(assessmentId) {
    const row = await read('Grading item', () =>
      sanityFetch({query: GRADING_ASSESSMENT_QUERY, params: {assessmentId}, revalidate: 0}),
    )
    return toGradingItem(row)
  },

  async loadHintLadder(assessmentId) {
    const row = await read('Hint ladder', () =>
      sanityFetch({query: HINT_LADDER_QUERY, params: {assessmentId}, revalidate: 0}),
    )
    return toHintLadder(row)
  },

  async loadConceptIndex() {
    const rows = await read('Concepts', () =>
      sanityFetch({query: CONCEPT_NODES_QUERY, revalidate: CONTENT_REVALIDATE_SECONDS}),
    )
    return toConceptIndex(rows)
  },

  async loadLessonCheckCandidates(lessonId) {
    const rows = await read('Check candidates', () =>
      sanityFetch({query: LESSON_CHECK_CANDIDATES_QUERY, params: {lessonId}, revalidate: 0}),
    )
    return toCheckCandidates(rows)
  },
}
