import type {GradingItem} from '../assessments/grading.ts'
import type {HintLadder} from '../assessments/hints.ts'
import type {LearnerAssessment} from '../assessments/learner.ts'
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
}

/** Published content could not be read; the request may be retried. */
export class ContentUnavailableError extends Error {
  constructor(message: string, options?: {cause?: unknown}) {
    super(message, options)
    this.name = 'ContentUnavailableError'
  }
}
