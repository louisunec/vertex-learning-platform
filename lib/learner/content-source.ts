import type {GradingItem} from '../assessments/grading.ts'
import type {HintLadder} from '../assessments/hints.ts'
import type {CheckCandidate, LearnerAssessment} from '../assessments/learner.ts'
import type {ConceptNode} from '../concepts/resolve.ts'

/**
 * Published content the learner-evidence services read. The Sanity
 * implementation is `content.ts` (server-only); tests pass fixtures.
 * Every method returns only parsed, published, servable data, or null.
 */
export type LearnerContentSource = {
  /** The learner-safe item when it can be issued now (latest servable version). */
  loadServableItem(assessmentId: string): Promise<LearnerAssessment | null>
  /** The private grading row while the delivered version is still approved and current. */
  loadGradingItem(assessmentId: string): Promise<GradingItem | null>
  /** The private hint ladder while the delivered version is still approved and current. */
  loadHintLadder(assessmentId: string): Promise<HintLadder | null>
  /** Published concept nodes by document id. */
  loadConceptIndex(): Promise<ReadonlyMap<string, ConceptNode>>
  /** Items a published lesson's understanding check may issue now (PR-7), at most 50. */
  loadLessonCheckCandidates(lessonId: string): Promise<CheckCandidate[]>
  /** Items a focused review may issue now, whose primary concept is one of `conceptRefs` (document ids), at most 100. */
  loadReviewCandidates(conceptRefs: string[]): Promise<CheckCandidate[]>
  /** Names of servable concepts by document id. */
  loadConceptNames(conceptIds: string[]): Promise<ReadonlyMap<string, string>>
  /** Titles and slugs of published lessons by id. */
  loadLessons(lessonIds: string[]): Promise<ReadonlyMap<string, LessonRef>>
}

export type LessonRef = {title: string; slug: string}

/** Published content could not be read; the request may be retried. */
export class ContentUnavailableError extends Error {
  constructor(message: string, options?: {cause?: unknown}) {
    super(message, options)
    this.name = 'ContentUnavailableError'
  }
}
