import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import type {ConceptNode} from './concepts/resolve.ts'
import {
  MAP_LAYOUT,
  RECENT_EVIDENCE_DAYS,
  attemptReason,
  canViewProposedEdges,
  displayableProposedEdges,
  drawableEdges,
  edgeSources,
  evidenceIdsFor,
  evidenceSummary,
  firstSource,
  layoutMap,
  lessonMomentHref,
  mapState,
  numberedLessons,
  orderConcepts,
  pickSelected,
  resolveEvidence,
  type AttemptFeedbackItem,
} from './knowledge-map.ts'
import {EMPTY_COUNTS} from './learner/evidence.ts'

const NOW = new Date('2026-09-13T12:00:00Z')
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000)
const counts = (overrides: Partial<typeof EMPTY_COUNTS>) => ({...EMPTY_COUNTS, ...overrides})

describe('mapState', () => {
  it('is not assessed without counted evidence', () => {
    assert.equal(mapState(EMPTY_COUNTS, null, NOW), 'not_assessed')
  })

  it('needs practice when the latest independent response was wrong, even after a correct assisted one (the design example)', () => {
    const state = mapState(counts({independentIncorrect: 1, assistedCorrect: 1}), {correct: false, createdAt: daysAgo(2)}, NOW)
    assert.equal(state, 'needs_practice')
  })

  it('shows recent evidence for a correct independent response within the window, developing after it', () => {
    const correct = counts({independentCorrect: 1})
    assert.equal(mapState(correct, {correct: true, createdAt: daysAgo(RECENT_EVIDENCE_DAYS)}, NOW), 'recent_evidence')
    assert.equal(mapState(correct, {correct: true, createdAt: daysAgo(RECENT_EVIDENCE_DAYS + 1)}, NOW), 'developing')
  })

  it('lets the latest independent response win over earlier ones', () => {
    const mixed = counts({independentCorrect: 3, independentIncorrect: 1})
    assert.equal(mapState(mixed, {correct: false, createdAt: daysAgo(1)}, NOW), 'needs_practice')
    assert.equal(mapState(counts({independentCorrect: 1, independentIncorrect: 3}), {correct: true, createdAt: daysAgo(1)}, NOW), 'recent_evidence')
  })

  it('caps assisted-only evidence at developing', () => {
    assert.equal(mapState(counts({assistedCorrect: 5}), null, NOW), 'developing')
    assert.equal(mapState(counts({assistedIncorrect: 2}), null, NOW), 'needs_practice')
  })

  it('treats independent counts without a readable latest attempt as developing, never recent', () => {
    assert.equal(mapState(counts({independentCorrect: 2}), null, NOW), 'developing')
  })
})

const node = (conceptId: string, extra: Partial<ConceptNode> = {}): ConceptNode => ({
  id: `concept-${conceptId}`,
  conceptId,
  reviewStatus: 'approved',
  ...extra,
})

const INDEX = new Map<string, ConceptNode>(
  [
    node('cpt-loss'),
    node('cpt-old-loss', {reviewStatus: 'merged', mergedInto: 'concept-cpt-loss'}),
    node('cpt-a'),
    node('cpt-b'),
    node('cpt-whole', {reviewStatus: 'split', splitInto: ['concept-cpt-a', 'concept-cpt-b']}),
    node('cpt-gone', {reviewStatus: 'archived'}),
  ].map((entry) => [entry.id, entry]),
)

describe('resolveEvidence', () => {
  it('passes a merged concept’s counts and latest response to its successor', () => {
    const byConcept = resolveEvidence(
      [
        {conceptId: 'cpt-loss', ...counts({assistedCorrect: 1})},
        {conceptId: 'cpt-old-loss', ...counts({independentIncorrect: 1})},
      ],
      [
        {conceptId: 'cpt-old-loss', correct: false, createdAt: daysAgo(3)},
        {conceptId: 'cpt-loss', correct: true, createdAt: daysAgo(5)},
      ],
      INDEX,
    )
    assert.deepEqual([...byConcept.keys()], ['concept-cpt-loss'])
    const loss = byConcept.get('concept-cpt-loss')!
    assert.deepEqual(loss.counts, counts({assistedCorrect: 1, independentIncorrect: 1}))
    assert.deepEqual(loss.latestIndependent, {correct: false, createdAt: daysAgo(3)})
  })

  it('never copies split, archived, or unknown concepts’ evidence to anything', () => {
    const byConcept = resolveEvidence(
      [
        {conceptId: 'cpt-whole', ...counts({independentCorrect: 1})},
        {conceptId: 'cpt-gone', ...counts({independentCorrect: 1})},
        {conceptId: 'cpt-missing', ...counts({independentCorrect: 1})},
      ],
      [{conceptId: 'cpt-whole', correct: true, createdAt: daysAgo(1)}],
      INDEX,
    )
    assert.equal(byConcept.size, 0)
  })

  it('reads a concept’s attempts under its own id and those merged into it', () => {
    assert.deepEqual(evidenceIdsFor({id: 'concept-cpt-loss', conceptId: 'cpt-loss'}, INDEX), ['cpt-loss', 'cpt-old-loss'])
    assert.deepEqual(evidenceIdsFor({id: 'concept-cpt-new', conceptId: 'cpt-new'}, INDEX), ['cpt-new'])
  })
})

const COURSE = {
  modules: [
    {lessons: [{_id: 'l1', title: 'Tensors', slug: 'tensors'}, {_id: 'l2', title: 'Autograd', slug: 'autograd'}]},
    {lessons: null},
    {lessons: [{_id: 'l3', title: 'Training', slug: 'training'}, {_id: 'l4', title: 'Loss functions in practice', slug: 'loss'}]},
  ],
}

describe('course order and sources', () => {
  const lessons = numberedLessons(COURSE)

  it('numbers lessons across modules in order', () => {
    assert.deepEqual([...lessons.values()].map((lesson) => [lesson._id, lesson.number]), [
      ['l1', 1],
      ['l2', 2],
      ['l3', 3],
      ['l4', 4],
    ])
  })

  it('picks the earliest moment by lesson order, then time, and links to its second', () => {
    const source = firstSource(
      [
        {lessonId: 'l4', startSeconds: 20},
        {lessonId: 'l3', startSeconds: 400},
        {lessonId: 'l3', startSeconds: 341.9},
        {lessonId: 'elsewhere', startSeconds: 1},
      ],
      lessons,
    )
    assert.equal(source?.lesson._id, 'l3')
    assert.equal(source?.lesson.number, 3)
    assert.equal(source?.href, '/lessons/training?t=341')
    assert.equal(firstSource([{lessonId: 'elsewhere', startSeconds: 5}], lessons), null)
    assert.equal(lessonMomentHref('loss', -3), '/lessons/loss?t=0')
  })

  it('lists an edge’s moments in this course in teaching order, once per second', () => {
    const sources = edgeSources(
      [
        {lessonId: 'l4', startSeconds: 20.6},
        {lessonId: 'l3', startSeconds: 341.9},
        {lessonId: 'l3', startSeconds: 341.2},
        {lessonId: 'elsewhere', startSeconds: 1},
        {lessonId: null, startSeconds: 5},
        {lessonId: 'l1', startSeconds: null},
        {lessonId: 'l1', startSeconds: -1},
      ],
      lessons,
    )
    assert.deepEqual(sources.map((source) => [source.lesson._id, source.startSeconds, source.href]), [
      ['l3', 341, '/lessons/training?t=341'],
      ['l4', 20, `/lessons/${lessons.get('l4')!.slug}?t=20`],
    ])
  })

  it('orders concepts as the course teaches them, sourceless ones last', () => {
    const concepts = [
      {id: 'c-eval', conceptId: 'cpt-eval', name: 'Evaluation', sources: [{lessonId: 'l4', startSeconds: 500}]},
      {id: 'c-none', conceptId: 'cpt-none', name: 'Aardvark', sources: []},
      {id: 'c-loss', conceptId: 'cpt-loss', name: 'Loss', sources: [{lessonId: 'l4', startSeconds: 341}]},
      {id: 'c-tensor', conceptId: 'cpt-tensor', name: 'Tensors', sources: [{lessonId: 'l1', startSeconds: 10}]},
    ]
    assert.deepEqual(orderConcepts(concepts, lessons).map((concept) => concept.id), ['c-tensor', 'c-loss', 'c-eval', 'c-none'])
  })
})

describe('drawableEdges', () => {
  const concepts = ['a', 'b', 'c'].map((id) => ({id, conceptId: `cpt-${id}`, name: id, sources: []}))

  it('draws valid approved edges and drops every edge named in a defect', () => {
    const {edges, dropped} = drawableEdges(concepts, [
      {id: 'e-ab', prerequisite: 'a', dependent: 'b', status: 'approved'},
      {id: 'e-bc', prerequisite: 'b', dependent: 'c', status: 'approved'},
      {id: 'e-cb', prerequisite: 'c', dependent: 'b', status: 'approved'},
      {id: 'e-aa', prerequisite: 'a', dependent: 'a', status: 'approved'},
      {id: 'e-ax', prerequisite: 'a', dependent: 'x', status: 'approved'},
    ])
    assert.deepEqual(edges, [{id: 'e-ab', from: 'a', to: 'b'}])
    assert.deepEqual(dropped, ['e-aa', 'e-ax', 'e-bc', 'e-cb'])
  })

  it('never draws an unapproved edge as a prerequisite', () => {
    const {edges} = drawableEdges(concepts, [
      {id: 'drafts.p-ab', prerequisite: 'a', dependent: 'b', status: 'proposed'},
      {id: 'p-bc', prerequisite: 'b', dependent: 'c', status: 'rejected'},
    ])
    assert.deepEqual(edges, [])
  })
})

describe('displayableProposedEdges', () => {
  const concepts = ['a', 'b', 'c', 'd'].map((id) => ({id, conceptId: `cpt-${id}`, name: id, sources: []}))
  const approved = [{id: 'e-ab', from: 'a', to: 'b'}]

  it('shows valid proposals and drops off-map, self, approved, repeated, and cyclic ones', () => {
    const {edges, dropped} = displayableProposedEdges(concepts, approved, [
      {id: 'p-bc', prerequisite: 'b', dependent: 'c'},
      {id: 'p-ax', prerequisite: 'a', dependent: 'x'},
      {id: 'p-cc', prerequisite: 'c', dependent: 'c'},
      {id: 'p-ab', prerequisite: 'a', dependent: 'b'},
      {id: 'p-ba', prerequisite: 'b', dependent: 'a'},
      {id: 'p-bc-2', prerequisite: 'b', dependent: 'c'},
      {id: 'p-null', prerequisite: null, dependent: 'c'},
    ])
    assert.deepEqual(edges, [{id: 'p-bc', from: 'b', to: 'c'}])
    assert.deepEqual(dropped, ['p-ab', 'p-ax', 'p-ba', 'p-bc-2', 'p-cc', 'p-null'])
  })

  it('drops every proposal inside a cycle with the approved graph, keeping the rest', () => {
    const {edges, dropped} = displayableProposedEdges(concepts, approved, [
      {id: 'p-bc', prerequisite: 'b', dependent: 'c'},
      {id: 'p-ca', prerequisite: 'c', dependent: 'a'},
      {id: 'p-ad', prerequisite: 'a', dependent: 'd'},
    ])
    assert.deepEqual(edges, [{id: 'p-ad', from: 'a', to: 'd'}])
    assert.deepEqual(dropped, ['p-bc', 'p-ca'])
  })
})

describe('canViewProposedEdges', () => {
  it('is on only for listed user ids', () => {
    assert.equal(canViewProposedEdges('user_1', ' user_2 , user_1 '), true)
    assert.equal(canViewProposedEdges('user_3', 'user_2,user_1'), false)
    assert.equal(canViewProposedEdges('user_1', undefined), false)
    assert.equal(canViewProposedEdges('user_1', ''), false)
    assert.equal(canViewProposedEdges('', ','), false)
  })
})

describe('layoutMap', () => {
  const {columns, nodeWidth: w, nodeHeight: h, columnGap, rowGap, paddingX, paddingY} = MAP_LAYOUT

  it('lays nodes out in rows of three in the given order', () => {
    const layout = layoutMap(['t', 'a', 'g', 'l', 'tl', 'e'], [])
    assert.equal(columns, 3)
    assert.deepEqual(layout.nodes.map((placed) => [placed.id, placed.row, placed.column]), [
      ['t', 0, 0],
      ['a', 0, 1],
      ['g', 0, 2],
      ['l', 1, 0],
      ['tl', 1, 1],
      ['e', 1, 2],
    ])
    assert.equal(layout.nodes[4].x, paddingX + w + columnGap)
    assert.equal(layout.nodes[4].y, paddingY + h + rowGap)
    assert.equal(layout.width, paddingX * 2 + 3 * w + 2 * columnGap)
    assert.equal(layout.height, paddingY * 2 + 2 * h + rowGap)
  })

  it('draws neighbours in a row straight and other edges as curves', () => {
    const layout = layoutMap(['t', 'a', 'g', 'l', 'tl', 'e'], [
      {id: 'ta', from: 't', to: 'a'},
      {id: 'atl', from: 'a', to: 'tl'},
      {id: 'tg', from: 't', to: 'g'},
      {id: 'missing', from: 't', to: 'nowhere'},
    ])
    const paths = new Map(layout.edges.map((edge) => [edge.id, edge.path]))
    assert.ok(!paths.has('missing'))
    assert.match(paths.get('ta')!, /^M [\d.]+ [\d.]+ L [\d.]+ [\d.]+$/)
    assert.match(paths.get('atl')!, /^M [\d.]+ [\d.]+ C /)
    assert.match(paths.get('tg')!, /^M [\d.]+ [\d.]+ C /)
    // The downward curve leaves the bottom of the source and ends above the target.
    const [, , y1] = paths.get('atl')!.split(' ')
    assert.equal(Number(y1), paddingY + h)
    assert.ok(Number(paths.get('atl')!.split(' ').at(-1)) < paddingY + h + rowGap)
  })

  it('is empty with no concepts', () => {
    assert.deepEqual(layoutMap([], []), {width: paddingX * 2 + 3 * w + 2 * columnGap, height: 0, nodes: [], edges: []})
  })
})

describe('pickSelected', () => {
  const nodes = [
    {conceptId: 'cpt-a', state: 'recent_evidence' as const},
    {conceptId: 'cpt-b', state: 'needs_practice' as const},
    {conceptId: 'cpt-c', state: 'not_assessed' as const},
  ]

  it('honours a requested concept that is on the map', () => {
    assert.equal(pickSelected(nodes, 'cpt-c')?.conceptId, 'cpt-c')
  })

  it('otherwise picks the first concept to practise, then the first concept', () => {
    assert.equal(pickSelected(nodes, 'cpt-elsewhere')?.conceptId, 'cpt-b')
    assert.equal(pickSelected(nodes.filter((entry) => entry.state !== 'needs_practice'), null)?.conceptId, 'cpt-a')
    assert.equal(pickSelected([], null), null)
  })
})

describe('attemptReason', () => {
  const items = new Map<string, AttemptFeedbackItem>([
    [
      'assessment-f1-v2',
      {
        id: 'assessment-f1-v2',
        version: 2,
        correctReason: 'Chose the correct loss function.',
        distractorReasons: [
          {optionId: 'opt-b', reason: 'Mixed up logits and probabilities.'},
          {optionId: 'opt-c', reason: '  '},
        ],
      },
    ],
  ])
  const base = {assessmentId: 'assessment-f1-v2', assessmentVersion: 2}

  it('returns only the reason for the option the learner chose', () => {
    assert.equal(attemptReason({...base, selectedOptionId: 'opt-a', correct: true}, items), 'Chose the correct loss function.')
    assert.equal(attemptReason({...base, selectedOptionId: 'opt-b', correct: false}, items), 'Mixed up logits and probabilities.')
  })

  it('returns nothing for another version, an unservable item, or a blank reason', () => {
    assert.equal(attemptReason({...base, assessmentVersion: 1, selectedOptionId: 'opt-b', correct: false}, items), null)
    assert.equal(attemptReason({...base, assessmentId: 'assessment-gone', selectedOptionId: 'opt-b', correct: false}, items), null)
    assert.equal(attemptReason({...base, selectedOptionId: 'opt-c', correct: false}, items), null)
    assert.equal(attemptReason({...base, selectedOptionId: 'opt-d', correct: false}, items), null)
  })
})

describe('evidenceSummary', () => {
  it('matches the design copy and says nothing without counted attempts', () => {
    assert.equal(evidenceSummary(2, 'needs_practice'), 'Based on 2 attempts; more practice needed.')
    assert.equal(evidenceSummary(1, 'recent_evidence'), 'Based on 1 attempt.')
    assert.equal(evidenceSummary(0, 'not_assessed'), null)
  })
})
