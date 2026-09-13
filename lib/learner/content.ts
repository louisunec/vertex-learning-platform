import 'server-only'

import {z} from 'zod'

import {toGradingItem, toConceptIndex} from '@/lib/assessments/grading'
import {toHintLadder} from '@/lib/assessments/hints'
import {toCheckCandidates, toLearnerAssessments} from '@/lib/assessments/learner'
import {cacheTags, CONTENT_REVALIDATE_SECONDS, sanityFetch} from '@/sanity/lib/fetch'
import {
  CONCEPT_NAMES_QUERY,
  CONCEPT_NODES_QUERY,
  GRADING_ASSESSMENT_QUERY,
  HINT_LADDER_QUERY,
  REVIEW_CANDIDATES_QUERY,
  SERVABLE_ASSESSMENT_QUERY,
} from '@/sanity/queries/assessments'
import {LESSONS_BY_IDS_QUERY} from '@/sanity/queries/my-learning'

import {ContentUnavailableError, type LearnerContentSource, type LessonRef} from './content-source'

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

  async loadReviewCandidates(conceptRefs) {
    if (conceptRefs.length === 0) return []
    const rows = await read('Review candidates', () =>
      sanityFetch({query: REVIEW_CANDIDATES_QUERY, params: {conceptRefs}, revalidate: 0}),
    )
    return toCheckCandidates(rows)
  },

  async loadConceptNames(conceptIds) {
    if (conceptIds.length === 0) return new Map()
    const rows = await read('Concept names', () =>
      sanityFetch({query: CONCEPT_NAMES_QUERY, params: {conceptIds}, revalidate: CONTENT_REVALIDATE_SECONDS}),
    )
    return new Map(parseRows(conceptNameRowSchema, rows).map((row) => [row.id, row.name]))
  },

  async loadLessons(lessonIds) {
    if (lessonIds.length === 0) return new Map()
    const rows = await read('Lessons', () =>
      sanityFetch({query: LESSONS_BY_IDS_QUERY, params: {lessonIds}, tags: [cacheTags.lesson]}),
    )
    return new Map<string, LessonRef>(parseRows(lessonRowSchema, rows).map((row) => [row._id, {title: row.title, slug: row.slug}]))
  },
}

const conceptNameRowSchema = z.object({id: z.string().min(1), name: z.string().trim().min(1)})
const lessonRowSchema = z.object({_id: z.string().min(1), title: z.string().trim().min(1), slug: z.string().min(1)})

/** Keeps the rows that parse; a malformed row is left out, never guessed. */
function parseRows<T>(schema: z.ZodType<T>, rows: unknown): T[] {
  if (!Array.isArray(rows)) return []
  return rows.flatMap((row) => {
    const parsed = schema.safeParse(row)
    return parsed.success ? [parsed.data] : []
  })
}
