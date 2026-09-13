import type {GradingItem} from '../assessments/grading.ts'
import type {HintLadder} from '../assessments/hints.ts'
import type {LearnerAssessment} from '../assessments/learner.ts'
import type {ConceptNode} from '../concepts/resolve.ts'
import type {LearnerContentSource} from './content-source.ts'

/**
 * In-memory content for the learner database tests, shaped like the parsed
 * Sanity rows. Deleting or editing an entry simulates content that was
 * withdrawn or changed after delivery.
 */

export const HINTS = {
  direction: 'Think about what has to survive a re-render.',
  keyConcept: 'React keeps component state between renders.',
  solution: 'useState stores a value that persists between renders.',
} as const

export class FixtureContent implements LearnerContentSource {
  servable = new Map<string, LearnerAssessment>()
  grading = new Map<string, GradingItem>()
  hints = new Map<string, HintLadder>()
  concepts = new Map<string, ConceptNode>()

  async loadServableItem(id: string) {
    return this.servable.get(id) ?? null
  }
  async loadGradingItem(id: string) {
    return this.grading.get(id) ?? null
  }
  async loadHintLadder(id: string) {
    return this.hints.get(id) ?? null
  }
  async loadConceptIndex() {
    return this.concepts
  }

  /** Adds an approved, current item; `opt-a` is correct. */
  addItem(familyId: string, {version = 1, concept = 'concept-cpt-state' as string | null} = {}) {
    const id = `assessment-${familyId}-v${version}`
    const options = [
      {id: 'opt-a', text: 'useState'},
      {id: 'opt-b', text: 'useEffect'},
      {id: 'opt-c', text: 'useMemo'},
    ]
    const optionIds = options.map((option) => option.id)
    this.servable.set(id, {
      _id: id,
      _rev: 'rev-1',
      familyId,
      version,
      lessonId: 'lesson-hooks',
      type: 'apply',
      responseFormat: 'single_choice',
      question: 'Which hook keeps a value between renders?',
      options,
    })
    this.grading.set(id, {
      _id: id,
      familyId,
      version,
      lessonId: 'lesson-hooks',
      optionIds,
      correctOptionId: 'opt-a',
      primaryConceptRef: concept,
    })
    this.hints.set(id, {_id: id, familyId, version, optionIds, correctOptionId: 'opt-a', ...HINTS})
    return id
  }
}
