import 'server-only'

import {toCheckCandidates} from '@/lib/assessments/learner'
import {cacheTags, CONTENT_REVALIDATE_SECONDS, sanityFetch} from '@/sanity/lib/fetch'
import {getProgressForUser} from '@/sanity/data/progress'
import {
  COURSE_CHECK_CANDIDATES_QUERY,
  GOAL_COURSES_QUERY,
  NEXT_ACTION_CONCEPTS_QUERY,
  NEXT_ACTION_COURSE_QUERY,
  NEXT_ACTION_EDGES_QUERY,
} from '@/sanity/queries/next-action'

import {sanityLearnerContent} from './content'
import {ContentUnavailableError} from './content-source'
import {
  toCourseOptions,
  toGoalCourse,
  toPlanConcepts,
  toPrerequisiteEdges,
  toProgressRows,
  type NextActionContentSource,
} from './next-action-source'

/**
 * Sanity-backed reads for the next-action service (PR-11), through the
 * published-perspective server client. Course structure and the concept
 * graph use the normal content revalidation; check candidates are uncached
 * (as for PR-7's check) so a withdrawn item is never offered; progress is
 * per-request learner state. Rows are parsed in `next-action-source.ts`;
 * a row that doesn't parse is left out, never guessed.
 */

async function read<T>(label: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw new ContentUnavailableError(`${label} could not be read`, {cause: error})
  }
}

export const sanityNextActionContent: NextActionContentSource = {
  loadConceptIndex: () => sanityLearnerContent.loadConceptIndex(),
  loadReviewCandidates: (refs) => sanityLearnerContent.loadReviewCandidates(refs),

  async loadGoalCourses() {
    const rows = await read('Courses', () => sanityFetch({query: GOAL_COURSES_QUERY, tags: [cacheTags.course]}))
    return toCourseOptions(rows)
  },

  async loadCourse(courseId) {
    const row = await read('Course', () =>
      sanityFetch({query: NEXT_ACTION_COURSE_QUERY, params: {courseId}, tags: [cacheTags.course, cacheTags.lesson]}),
    )
    return row ? toGoalCourse(row) : null
  },

  async loadProgress(learnerId) {
    const rows = await read('Progress', () => getProgressForUser(learnerId))
    return toProgressRows(rows)
  },

  async loadCourseConcepts(lessonIds) {
    if (lessonIds.length === 0) return []
    const rows = await read('Concepts', () =>
      sanityFetch({query: NEXT_ACTION_CONCEPTS_QUERY, params: {lessonIds}, revalidate: CONTENT_REVALIDATE_SECONDS}),
    )
    return toPlanConcepts(rows)
  },

  async loadPrerequisiteEdges(conceptIds) {
    if (conceptIds.length === 0) return []
    const rows = await read('Prerequisites', () =>
      sanityFetch({query: NEXT_ACTION_EDGES_QUERY, params: {conceptIds}, revalidate: CONTENT_REVALIDATE_SECONDS}),
    )
    return toPrerequisiteEdges(rows)
  },

  async loadCourseCheckCandidates(lessonIds) {
    if (lessonIds.length === 0) return []
    const rows = await read('Check candidates', () =>
      sanityFetch({query: COURSE_CHECK_CANDIDATES_QUERY, params: {lessonIds}, revalidate: 0}),
    )
    return toCheckCandidates(rows)
  },
}
