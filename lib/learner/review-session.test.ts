import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import type {CheckCandidate} from '../assessments/learner.ts'
import type {ConceptNode} from '../concepts/resolve.ts'
import {reviewSessionResponseSchema} from './contracts.ts'
import {
  conceptRefsFor,
  MAX_MISTAKE_CONCEPTS,
  pickMistakes,
  planSession,
  reviewReason,
  type LatestCounted,
  type Mistake,
} from './review-session.ts'

/**
 * Focused-review selection (prompts/focused-review.md): which concepts count
 * as recent mistakes, in what order, and which unseen questions a session
 * gets, within its caps. Pure; the database tests cover persistence.
 */

const NOW = new Date('2026-09-14T12:00:00Z')
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000)

function node(conceptId: string, extra: Partial<ConceptNode> = {}): [string, ConceptNode] {
  const id = `concept-${conceptId}`
  return [id, {id, conceptId, reviewStatus: 'approved', ...extra}]
}

const INDEX = new Map<string, ConceptNode>([
  node('cpt-loss'),
  node('cpt-grad'),
  node('cpt-metrics'),
  node('cpt-extra'),
  node('cpt-old-loss', {reviewStatus: 'merged', mergedInto: 'concept-cpt-loss'}),
  node('cpt-split', {reviewStatus: 'split', splitInto: ['concept-cpt-grad', 'concept-cpt-metrics']}),
  node('cpt-draft', {reviewStatus: 'draft'}),
])

const row = (conceptId: string, evidenceKind: 'independent' | 'assisted', correct: boolean, createdAt: Date): LatestCounted => ({
  conceptId,
  evidenceKind,
  correct,
  createdAt,
})

function candidate(familyId: string, concept: string | null, firstSeconds: number | null = 60): CheckCandidate {
  return {
    item: {
      _id: `assessment-${familyId}-v1`,
      _rev: 'rev-1',
      familyId,
      version: 1,
      lessonId: 'lesson-1',
      type: 'apply',
      responseFormat: 'single_choice',
      question: `Question ${familyId}?`,
      options: [
        {id: 'opt-a', text: 'A'},
        {id: 'opt-b', text: 'B'},
        {id: 'opt-c', text: 'C'},
      ],
    },
    primaryConceptRef: concept,
    firstSeconds,
  }
}

const mistake = (conceptId: string, reason: Mistake['reason'] = 'independent_incorrect'): Mistake => ({
  conceptDocId: `concept-${conceptId}`,
  conceptId,
  reason,
  at: daysAgo(1),
})

describe('reviewReason', () => {
  it('reviews anything but an independent correct answer', () => {
    assert.equal(reviewReason({evidenceKind: 'independent', correct: false}), 'independent_incorrect')
    assert.equal(reviewReason({evidenceKind: 'assisted', correct: false}), 'assisted_incorrect')
    assert.equal(reviewReason({evidenceKind: 'assisted', correct: true}), 'assisted_correct')
    assert.equal(reviewReason({evidenceKind: 'independent', correct: true}), null)
  })
})

describe('pickMistakes', () => {
  it('orders by reason, then most recent first', () => {
    const picked = pickMistakes(
      [
        row('cpt-grad', 'assisted', true, daysAgo(1)),
        row('cpt-loss', 'independent', false, daysAgo(5)),
        row('cpt-metrics', 'assisted', false, daysAgo(2)),
        row('cpt-extra', 'independent', false, daysAgo(3)),
      ],
      INDEX,
      NOW,
    )
    assert.deepEqual(
      picked.map((m) => [m.conceptId, m.reason]),
      [
        ['cpt-extra', 'independent_incorrect'],
        ['cpt-loss', 'independent_incorrect'],
        ['cpt-metrics', 'assisted_incorrect'],
        ['cpt-grad', 'assisted_correct'],
      ],
    )
  })

  it('leaves out concepts whose latest counted answer was independent and correct', () => {
    assert.deepEqual(pickMistakes([row('cpt-loss', 'independent', true, daysAgo(1))], INDEX, NOW), [])
  })

  it('ignores attempts older than the window', () => {
    assert.deepEqual(pickMistakes([row('cpt-loss', 'independent', false, daysAgo(31))], INDEX, NOW), [])
    assert.equal(pickMistakes([row('cpt-loss', 'independent', false, daysAgo(29))], INDEX, NOW).length, 1)
  })

  it('resolves merged ids to their successor, whose newest attempt decides', () => {
    const wrongThenRight = pickMistakes(
      [row('cpt-old-loss', 'independent', false, daysAgo(4)), row('cpt-loss', 'independent', true, daysAgo(2))],
      INDEX,
      NOW,
    )
    assert.deepEqual(wrongThenRight, [])
    const [picked] = pickMistakes(
      [row('cpt-old-loss', 'assisted', true, daysAgo(1)), row('cpt-loss', 'independent', false, daysAgo(2))],
      INDEX,
      NOW,
    )
    assert.deepEqual([picked.conceptDocId, picked.conceptId, picked.reason], ['concept-cpt-loss', 'cpt-loss', 'assisted_correct'])
  })

  it('leaves out split, unapproved, and unknown concepts', () => {
    const rows = ['cpt-split', 'cpt-draft', 'cpt-missing'].map((id) => row(id, 'independent', false, daysAgo(1)))
    assert.deepEqual(pickMistakes(rows, INDEX, NOW), [])
  })

  it('is bounded', () => {
    const index = new Map(Array.from({length: MAX_MISTAKE_CONCEPTS + 5}, (_, i) => node(`cpt-${i}`)))
    const rows = [...index.values()].map((n) => row(n.conceptId, 'independent', false, daysAgo(1)))
    assert.equal(pickMistakes(rows, index, NOW).length, MAX_MISTAKE_CONCEPTS)
  })
})

describe('conceptRefsFor', () => {
  it('includes concepts merged into the reviewed ones', () => {
    assert.deepEqual(conceptRefsFor(['concept-cpt-loss'], INDEX), ['concept-cpt-loss', 'concept-cpt-old-loss'])
  })
})

describe('planSession', () => {
  const three = [mistake('cpt-loss'), mistake('cpt-grad', 'assisted_incorrect'), mistake('cpt-metrics', 'assisted_correct')]

  it('takes up to two unseen questions per concept, in cited order, and five in all', () => {
    const plan = planSession(
      three,
      [
        candidate('loss-b', 'concept-cpt-loss', 120),
        candidate('loss-a', 'concept-cpt-loss', 30),
        candidate('loss-c', 'concept-cpt-loss', 10),
        candidate('grad-a', 'concept-cpt-grad'),
        candidate('grad-b', 'concept-cpt-grad', null),
        candidate('metrics-a', 'concept-cpt-metrics'),
        candidate('metrics-b', 'concept-cpt-metrics'),
      ],
      INDEX,
      new Set(['loss-c']),
    )
    assert.equal(plan.status, 'planned')
    assert.deepEqual(
      plan.status === 'planned' && plan.items.map(({mistake, candidate}) => [mistake.conceptId, candidate.item.familyId]),
      [
        ['cpt-loss', 'loss-a'],
        ['cpt-loss', 'loss-b'],
        ['cpt-grad', 'grad-a'],
        ['cpt-grad', 'grad-b'],
        ['cpt-metrics', 'metrics-a'],
      ],
    )
  })

  it('drops a concept with no unseen question instead of repeating one', () => {
    const plan = planSession(
      three,
      [candidate('loss-a', 'concept-cpt-loss'), candidate('grad-a', 'concept-cpt-grad')],
      INDEX,
      new Set(['loss-a']),
    )
    assert.deepEqual(plan.status === 'planned' && plan.items.map((item) => item.mistake.conceptId), ['cpt-grad'])
  })

  it('caps the session at three concepts', () => {
    const plan = planSession(
      [...three, mistake('cpt-extra')],
      ['cpt-loss', 'cpt-grad', 'cpt-metrics', 'cpt-extra'].map((id) => candidate(`${id}-a`, `concept-${id}`)),
      INDEX,
      new Set(),
    )
    assert.deepEqual(
      plan.status === 'planned' && [...new Set(plan.items.map((item) => item.mistake.conceptId))],
      ['cpt-loss', 'cpt-grad', 'cpt-metrics'],
    )
  })

  it('files items under their resolved concept and skips items without an active one', () => {
    const plan = planSession(
      [mistake('cpt-loss')],
      [candidate('old', 'concept-cpt-old-loss'), candidate('none', null), candidate('split', 'concept-cpt-split')],
      INDEX,
      new Set(),
    )
    assert.deepEqual(plan.status === 'planned' && plan.items.map((item) => item.candidate.item.familyId), ['old'])
  })

  it('says why nothing was planned', () => {
    assert.deepEqual(planSession([], [candidate('a', 'concept-cpt-loss')], INDEX, new Set()), {status: 'none', reason: 'no_recent_mistakes'})
    assert.deepEqual(planSession([mistake('cpt-loss')], [], INDEX, new Set()), {status: 'none', reason: 'no_unseen_questions'})
  })
})

describe('reviewSessionResponseSchema', () => {
  const task = {taskInstanceId: '00000000-0000-4000-8000-000000000001', expiresAt: '2026-09-15T12:00:00.000Z', item: candidate('a', null).item}
  const active = {
    status: 'active',
    sessionId: '00000000-0000-4000-8000-000000000002',
    expiresAt: '2026-09-15T12:00:00.000Z',
    resumed: false,
    concepts: [{conceptId: 'cpt-loss', name: 'Loss functions', reason: 'independent_incorrect'}],
    items: [{position: 1, conceptId: 'cpt-loss', state: 'open', task, refresher: {lessonTitle: 'Losses', startSeconds: 341}}],
  }

  it('accepts a learner-safe session', () => {
    assert.equal(reviewSessionResponseSchema.safeParse(active).success, true)
  })

  it('rejects an answer key, a lesson link before it is recorded, or items out of order', () => {
    const withKey = {...active, items: [{...active.items[0], task: {...task, item: {...task.item, correctOptionId: 'opt-a'}}}]}
    const withHref = {...active, items: [{...active.items[0], refresher: {lessonTitle: 'Losses', startSeconds: 341, href: '/lessons/x?t=341'}}]}
    const outOfOrder = {...active, items: [{...active.items[0], position: 2}]}
    const unlisted = {...active, items: [{...active.items[0], conceptId: 'cpt-other'}]}
    for (const body of [withKey, withHref, outOfOrder, unlisted]) {
      assert.equal(reviewSessionResponseSchema.safeParse(body).success, false)
    }
  })
})
