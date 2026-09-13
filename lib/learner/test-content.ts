import type {GradingItem} from '../assessments/grading.ts'
import type {HintLadder} from '../assessments/hints.ts'
import type {CheckCandidate, LearnerAssessment} from '../assessments/learner.ts'
import type {ConceptNode} from '../concepts/resolve.ts'
import type {LearnerContentSource, LessonRef} from './content-source.ts'

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

/** The default earliest cited second of a fixture item (5:41). */
export const FIRST_SECONDS = 341

export class FixtureContent implements LearnerContentSource {
  servable = new Map<string, LearnerAssessment>()
  grading = new Map<string, GradingItem>()
  hints = new Map<string, HintLadder>()
  concepts = new Map<string, ConceptNode>()
  /** Earliest cited source second per item id (check ordering); absent = none cited. */
  firstSeconds = new Map<string, number>()
  names = new Map<string, string>()
  lessons = new Map<string, LessonRef>([['lesson-hooks', {title: 'Hooks', slug: 'hooks'}]])
  /** Earliest cited second per item id (`FIRST_SECONDS` when unset; null when it cites none). */
  seconds = new Map<string, number | null>()

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
  async loadLessonCheckCandidates(lessonId: string): Promise<CheckCandidate[]> {
    return [...this.servable.values()]
      .filter((item) => item.lessonId === lessonId)
      .map((item) => ({
        item,
        primaryConceptRef: this.grading.get(item._id)?.primaryConceptRef ?? null,
        firstSeconds: this.firstSeconds.get(item._id) ?? null,
      }))
  }
  /** The latest servable version per family whose primary concept is in `refs`. */
  async loadReviewCandidates(refs: string[]) {
    const latest = new Map<string, CheckCandidate>()
    for (const item of this.servable.values()) {
      const concept = this.grading.get(item._id)?.primaryConceptRef ?? null
      if (!concept || !refs.includes(concept)) continue
      const current = latest.get(item.familyId)
      if (current && current.item.version >= item.version) continue
      const firstSeconds = this.seconds.has(item._id) ? (this.seconds.get(item._id) ?? null) : FIRST_SECONDS
      latest.set(item.familyId, {item, primaryConceptRef: concept, firstSeconds})
    }
    return [...latest.values()]
  }
  async loadConceptNames(ids: string[]) {
    return new Map([...this.names].filter(([id]) => ids.includes(id)))
  }
  async loadLessons(ids: string[]) {
    return new Map([...this.lessons].filter(([id]) => ids.includes(id)))
  }

  /** Adds an approved, current item; `opt-a` is correct. */
  addItem(
    familyId: string,
    {
      version = 1,
      concept = 'concept-cpt-state' as string | null,
      lessonId = 'lesson-hooks',
      firstSeconds = null as number | null,
    } = {},
  ) {
    const id = `assessment-${familyId}-v${version}`
    if (firstSeconds !== null) this.firstSeconds.set(id, firstSeconds)
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
      lessonId,
      type: 'apply',
      responseFormat: 'single_choice',
      question: 'Which hook keeps a value between renders?',
      options,
    })
    this.grading.set(id, {
      _id: id,
      familyId,
      version,
      lessonId,
      optionIds,
      correctOptionId: 'opt-a',
      primaryConceptRef: concept,
    })
    this.hints.set(id, {_id: id, familyId, version, optionIds, correctOptionId: 'opt-a', ...HINTS})
    return id
  }
}
