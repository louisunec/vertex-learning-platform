import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import type {GraphEdge} from './concepts/graph.ts'
import type {ConceptNode} from './concepts/resolve.ts'
import type {ProgressRow} from './course-progress.ts'
import type {ConceptEvidenceSummary} from './knowledge-map.ts'
import {EMPTY_COUNTS, type MasteryCounts} from './learner/evidence.ts'
import {planItemSchema} from './learner/next-action-contracts.ts'
import {
  buildPlan,
  conceptSpan,
  isDemonstrated,
  MAX_CHECK_ITEMS,
  PLAN_LIMIT,
  type CheckOffer,
  type PlanConcept,
  type PlanInput,
  type PlanLesson,
  type PracticeInput,
} from './next-action.ts'

/**
 * The next-action planner over fixtures: candidate generation per evidence
 * state, prerequisite readiness under valid and defective graphs, cold
 * starts, delivery gating, deterministic ordering, and links.
 */

const NOW = new Date('2026-09-14T00:00:00Z')

const LESSONS: PlanLesson[] = [
  {_id: 'lesson-1', title: 'Authentication', slug: 'authentication', number: 1, durationSeconds: 600},
  {_id: 'lesson-2', title: 'Authorization', slug: 'authorization', number: 2, durationSeconds: 900},
  {_id: 'lesson-3', title: 'Sessions', slug: 'sessions', number: 3, durationSeconds: null},
  {_id: 'lesson-4', title: 'Tokens', slug: 'tokens', number: 4, durationSeconds: 700},
]

function concept(conceptId: string, name: string, lessonId: string, start: number, end: number | null = start + 30): PlanConcept {
  return {
    id: `concept-${conceptId}`,
    conceptId,
    name,
    sources: [{chunkId: `${conceptId}-chunk-1`, lessonId, startSeconds: start, endSeconds: end}],
  }
}

const AUTHN = concept('cpt-authn', 'Authentication', 'lesson-1', 60)
const AUTHZ = concept('cpt-authz', 'Authorization', 'lesson-2', 120)
const SESSIONS = concept('cpt-sessions', 'Server-side sessions', 'lesson-3', 30)
const JWT = concept('cpt-jwt', 'JSON Web Tokens', 'lesson-4', 45)
const CONCEPTS = [AUTHN, AUTHZ, SESSIONS, JWT]

function node(id: string, conceptId: string, reviewStatus = 'approved', extra: Partial<ConceptNode> = {}): ConceptNode {
  return {id, conceptId, reviewStatus, ...extra}
}

const INDEX = new Map<string, ConceptNode>([
  ...CONCEPTS.map((entry) => [entry.id, node(entry.id, entry.conceptId)] as const),
  ['concept-cpt-http', node('concept-cpt-http', 'cpt-http')],
  ['concept-cpt-draft', node('concept-cpt-draft', 'cpt-draft', 'needs_review')],
])

function edge(id: string, prerequisite: string, dependent: string, status = 'approved'): GraphEdge {
  return {id, prerequisite: `concept-${prerequisite}`, dependent: `concept-${dependent}`, status}
}

function evidence(counts: Partial<MasteryCounts>, latest: {correct: boolean; daysAgo: number} | null): ConceptEvidenceSummary {
  return {
    counts: {...EMPTY_COUNTS, ...counts},
    latestIndependent: latest ? {correct: latest.correct, createdAt: new Date(NOW.getTime() - latest.daysAgo * 86_400_000)} : null,
  }
}

const DEMONSTRATED = evidence({independentCorrect: 1}, {correct: true, daysAgo: 2})
const MISSED = evidence({independentIncorrect: 1}, {correct: false, daysAgo: 1})
const ASSISTED_CORRECT = evidence({assistedCorrect: 1}, null)
const ASSISTED_WRONG = evidence({assistedIncorrect: 2}, null)

function input(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    course: {id: 'course-security', title: 'Practical Web Security', slug: 'practical-web-security', lessons: LESSONS},
    progress: [],
    concepts: CONCEPTS,
    edges: [],
    evidence: new Map(),
    index: INDEX,
    practice: {status: 'unavailable'},
    checks: {status: 'unavailable'},
    now: NOW,
    ...overrides,
  }
}

function row(lessonId: string, overrides: Partial<ProgressRow> = {}): ProgressRow {
  return {lessonId, completed: false, resumeSeconds: null, updatedAt: '2026-09-12T00:00:00Z', ...overrides}
}

const kinds = (plan: ReturnType<typeof buildPlan>) => plan.items.map((item) => `${item.kind}:${item.reasonCode}:${item.id}`)

describe('buildPlan: cold start and missing content', () => {
  it('follows course order honestly with no evidence, no edges, and no check', () => {
    const plan = buildPlan(input())
    assert.deepEqual(kinds(plan), [
      'learn:no_prerequisites_recorded:learn:cpt-authn',
      'learn:no_prerequisites_recorded:learn:cpt-authz',
      'learn:no_prerequisites_recorded:learn:cpt-sessions',
      'learn:no_prerequisites_recorded:learn:cpt-jwt',
    ])
    assert.deepEqual(plan.notices, ['no_prerequisite_edges', 'no_evidence_no_check'])
    const [first] = plan.items
    assert.equal(first.href, '/lessons/authentication?t=60')
    assert.deepEqual(first.span, {startSeconds: 60, endSeconds: 90})
    assert.match(first.reason, /haven’t answered any questions on Authentication yet/)
    assert.match(first.reason, /No prerequisites are recorded/)
    for (const item of plan.items) {
      assert.doesNotMatch(item.reason, /diagnos|personal|master|ready for|weak/i, item.reason)
      assert.equal(item.provenance.readiness, 'none_recorded')
    }
  })

  it('keeps a plan that says it follows course order in course order, lessons without concepts included', () => {
    const plan = buildPlan(input({concepts: [AUTHZ, JWT]}))
    assert.deepEqual(
      plan.items.map((item) => item.id),
      ['next:lesson-1', 'learn:cpt-authz', 'learn:cpt-jwt'],
    )
    assert.ok(plan.notices.includes('no_evidence_no_check'))
    const numbers = plan.items.map((item) => item.lesson!.number)
    assert.deepEqual(numbers, numbers.toSorted((a, b) => a - b))
  })

  it('falls back to the first lesson, labelled as course order, when no concept is reviewed', () => {
    const plan = buildPlan(input({concepts: []}))
    assert.deepEqual(kinds(plan), ['next_lesson:course_order:next:lesson-1'])
    assert.equal(plan.items[0].reason, 'Lesson 1 of 4 in course order.')
    assert.equal(plan.items[0].href, '/lessons/authentication')
    assert.deepEqual(plan.notices, ['no_reviewed_concepts'])
  })

  it('says the course is complete, and recommends nothing new, when every lesson is done', () => {
    const progress = LESSONS.map((lesson) => row(lesson._id, {completed: true}))
    const evidenceMap = new Map(CONCEPTS.map((entry) => [entry.id, DEMONSTRATED]))
    const plan = buildPlan(input({progress, evidence: evidenceMap}))
    assert.deepEqual(plan.items, [])
    assert.deepEqual(plan.notices, ['no_prerequisite_edges', 'no_eligible_concept', 'course_complete'])
  })

  it('does not offer to learn concepts whose lessons are complete, and never infers mastery from watching', () => {
    const plan = buildPlan(input({progress: [row('lesson-1', {completed: true})]}))
    assert.ok(!plan.items.some((item) => item.id === 'learn:cpt-authn'))
    assert.ok(!plan.items.some((item) => item.provenance.evidence.some((trace) => trace.state !== 'not_assessed')))
  })
})

describe('buildPlan: prerequisites', () => {
  const edges = [edge('edge-authn-authz', 'cpt-authn', 'cpt-authz')]

  it('holds a dependent back until its prerequisite is independently demonstrated', () => {
    const blocked = buildPlan(input({edges}))
    assert.ok(!blocked.items.some((item) => item.id === 'learn:cpt-authz'))
    assert.ok(!blocked.notices.includes('no_prerequisite_edges'))

    const ready = buildPlan(input({edges, evidence: new Map([[AUTHN.id, DEMONSTRATED]])}))
    const item = ready.items.find((entry) => entry.id === 'learn:cpt-authz')!
    assert.equal(item.reasonCode, 'prerequisites_demonstrated')
    assert.equal(item.reason, 'You answered its prerequisite Authentication correctly on your own within the last 30 days.')
    assert.deepEqual(item.provenance.prerequisites, [
      {conceptId: 'cpt-authn', demonstrated: true, inCourse: true, state: 'recent_evidence', latestIndependentAt: '2026-09-12T00:00:00.000Z'},
    ])
    assert.equal(item.provenance.readiness, 'met')
    assert.equal(ready.items[0].id, 'learn:cpt-authz', 'a verified-ready concept outranks course-order ones')
  })

  it('keeps older prerequisite evidence, says how old it is, and ranks it after recent confirmation', () => {
    const OLDER = evidence({independentCorrect: 2, independentIncorrect: 1}, {correct: true, daysAgo: 45})
    const chain = [...edges, edge('edge-sessions-jwt', 'cpt-sessions', 'cpt-jwt')]
    const plan = buildPlan(input({edges: chain, evidence: new Map([[AUTHN.id, OLDER], [SESSIONS.id, DEMONSTRATED]])}))
    const older = plan.items.find((entry) => entry.id === 'learn:cpt-authz')!
    assert.equal(older.reasonCode, 'prerequisites_demonstrated_earlier')
    assert.equal(older.kind, 'learn')
    assert.equal(
      older.reason,
      'You answered its prerequisite Authentication correctly on your own. Your latest answer on Authentication was 1 month ago. Answers older than 30 days count as developing, not recent evidence.',
    )
    assert.doesNotMatch(older.reason, /recent(ly)? (confirm|demonstrat)|within the last|incorrect|weak|forgot/i)
    assert.deepEqual(older.provenance.prerequisites, [
      {conceptId: 'cpt-authn', demonstrated: true, inCourse: true, state: 'developing', latestIndependentAt: '2026-07-31T00:00:00.000Z'},
    ])
    assert.deepEqual(
      plan.items.slice(0, 2).map((entry) => entry.id),
      ['learn:cpt-jwt', 'learn:cpt-authz'],
      'recent confirmation first, older evidence next, both ahead of course order',
    )
    planItemSchema.parse(older)

    // Age alone is not failure: the older concept itself is not offered as a weak-evidence revisit.
    assert.ok(!plan.items.some((entry) => entry.concept?.conceptId === 'cpt-authn'))
  })

  it('names which of several prerequisites have only older evidence', () => {
    const dependent = [edge('edge-a', 'cpt-authn', 'cpt-jwt'), edge('edge-b', 'cpt-authz', 'cpt-jwt'), edge('edge-c', 'cpt-sessions', 'cpt-jwt')]
    const old = (daysAgo: number) => evidence({independentCorrect: 1}, {correct: true, daysAgo})
    const plan = buildPlan(
      input({edges: dependent, evidence: new Map([[AUTHN.id, old(40)], [AUTHZ.id, DEMONSTRATED], [SESSIONS.id, old(75)]])}),
    )
    const item = plan.items.find((entry) => entry.id === 'learn:cpt-jwt')!
    assert.equal(item.reasonCode, 'prerequisites_demonstrated_earlier')
    assert.match(item.reason, /Your latest answers on Authentication and Server-side sessions are older than 30 days, the oldest from 2 months ago\./)
  })

  it('never lets assisted, missed, or unknown evidence satisfy a prerequisite', () => {
    for (const summary of [ASSISTED_CORRECT, ASSISTED_WRONG, MISSED, evidence({independentCorrect: 1}, null)]) {
      assert.equal(isDemonstrated(summary), false)
      const plan = buildPlan(input({edges, evidence: new Map([[AUTHN.id, summary]])}))
      assert.ok(!plan.items.some((item) => item.id === 'learn:cpt-authz'))
    }
    assert.equal(isDemonstrated(evidence({independentCorrect: 1, independentIncorrect: 1}, {correct: true, daysAgo: 90})), true)
  })

  it('marks every concept on a cycle unverified instead of ready, and says so', () => {
    const cycle = [edge('edge-a', 'cpt-authn', 'cpt-authz'), edge('edge-b', 'cpt-authz', 'cpt-authn')]
    const plan = buildPlan(input({edges: cycle, evidence: new Map([[AUTHN.id, DEMONSTRATED], [AUTHZ.id, DEMONSTRATED]])}))
    assert.ok(plan.notices.includes('prerequisite_graph_defects'))
    const unverified = buildPlan(input({edges: cycle}))
    const item = unverified.items.find((entry) => entry.id === 'learn:cpt-authz')!
    assert.equal(item.reasonCode, 'prerequisites_unverified')
    assert.equal(item.provenance.readiness, 'unverified')
    assert.match(item.reason, /couldn’t be verified/)
    assert.ok(!unverified.items.some((entry) => entry.reasonCode === 'prerequisites_demonstrated'))
  })

  it('checks a prerequisite taught in another course, and distrusts one that is not approved', () => {
    const external = [edge('edge-http', 'cpt-http', 'cpt-authn')]
    assert.ok(!buildPlan(input({edges: external})).items.some((item) => item.id === 'learn:cpt-authn'))
    const met = buildPlan(input({edges: external, evidence: new Map([['concept-cpt-http', DEMONSTRATED]])}))
    const item = met.items.find((entry) => entry.id === 'learn:cpt-authn')!
    assert.equal(item.reason, 'You answered its prerequisite a concept from another course correctly on your own within the last 30 days.')
    assert.deepEqual(item.provenance.prerequisites, [
      {conceptId: 'cpt-http', demonstrated: true, inCourse: false, state: 'recent_evidence', latestIndependentAt: '2026-09-12T00:00:00.000Z'},
    ])

    const draft = buildPlan(input({edges: [edge('edge-draft', 'cpt-draft', 'cpt-authn')]}))
    assert.equal(draft.items.find((entry) => entry.id === 'learn:cpt-authn')?.reasonCode, 'prerequisites_unverified')
    assert.ok(draft.notices.includes('prerequisite_graph_defects'))
  })

  it('ignores edges that are not approved', () => {
    const plan = buildPlan(input({edges: [edge('edge-proposed', 'cpt-authn', 'cpt-authz', 'proposed')]}))
    assert.equal(plan.items.find((item) => item.id === 'learn:cpt-authz')?.reasonCode, 'no_prerequisites_recorded')
    assert.ok(plan.notices.includes('no_prerequisite_edges'))
  })
})

describe('buildPlan: evidence states', () => {
  it('revisits a concept missed on the learner’s own, and says only what the evidence shows', () => {
    const plan = buildPlan(input({evidence: new Map([[AUTHZ.id, MISSED]]), practice: {status: 'none'}}))
    const item = plan.items[0]
    assert.equal(item.id, 'learn:cpt-authz')
    assert.equal(item.reasonCode, 'weak_evidence_revisit')
    assert.equal(
      item.reason,
      'Your last answer on Authorization, given on your own, was incorrect. Focused review isn’t offering a question on it right now. Revisit where the lesson explains it.',
    )
    assert.equal(item.actionLabel, 'Revisit from 2:00')
    assert.equal(item.provenance.evidence[0].state, 'needs_practice')
  })

  it('treats assisted answers as assisted, never as independent evidence', () => {
    const plan = buildPlan(input({evidence: new Map([[AUTHN.id, ASSISTED_CORRECT], [AUTHZ.id, ASSISTED_WRONG]])}))
    const authn = plan.items.find((item) => item.id === 'learn:cpt-authn')!
    const authz = plan.items.find((item) => item.id === 'learn:cpt-authz')!
    assert.equal(authn.reason, 'Your correct answers on Authentication used help, so there’s no independent answer yet. Revisit where the lesson explains it.')
    assert.equal(authz.reason, 'You’ve answered Authorization only with help, and not correctly yet. Revisit where the lesson explains it.')
    assert.ok(!plan.notices.includes('no_evidence_no_check'))
  })

  it('recommends nothing for a concept with recent independent evidence', () => {
    const plan = buildPlan(input({evidence: new Map([[AUTHN.id, DEMONSTRATED]])}))
    assert.ok(!plan.items.some((item) => item.concept?.conceptId === 'cpt-authn'))
  })
})

describe('buildPlan: delivery routes', () => {
  const session = (concepts: Array<[string, 'independent_incorrect' | 'assisted_correct']>, resumed = false): PracticeInput => ({
    status: 'session',
    resumed,
    concepts: concepts.map(([conceptId, reason]) => ({conceptDocId: `concept-${conceptId}`, conceptId, reason})),
  })

  it('puts a focused review that covers a course concept first, and does not repeat it as a revisit', () => {
    const plan = buildPlan(
      input({evidence: new Map([[AUTHZ.id, MISSED]]), practice: session([['cpt-authz', 'independent_incorrect'], ['cpt-elsewhere', 'assisted_correct']])}),
    )
    const [first] = plan.items
    assert.equal(first.kind, 'practise')
    assert.equal(first.href, '/my-learning/reviews')
    assert.equal(first.actionLabel, 'Start focused review')
    assert.equal(first.reason, 'Your last answer on Authorization, given on your own, was incorrect. Focused review covers it and 1 other concept.')
    assert.deepEqual(first.provenance.review, {resumed: false, conceptIds: ['cpt-authz', 'cpt-elsewhere']})
    assert.ok(!plan.items.some((item) => item.reasonCode === 'weak_evidence_revisit'))
  })

  it('offers no practice when focused review would serve only other courses’ concepts', () => {
    const plan = buildPlan(input({practice: session([['cpt-elsewhere', 'independent_incorrect']], true)}))
    assert.ok(!plan.items.some((item) => item.kind === 'practise'))
  })

  it('offers a lesson check only where it would issue a question on a concept with no evidence', () => {
    const byLesson = new Map<string, CheckOffer>([
      ['lesson-1', {conceptDocId: AUTHN.id, remaining: 2, total: 2}],
      ['lesson-2', {conceptDocId: AUTHZ.id, remaining: 1, total: 3}],
      ['lesson-3', {conceptDocId: null, remaining: 1, total: 1}],
      ['lesson-4', {conceptDocId: JWT.id, remaining: 1, total: 1}],
    ])
    const plan = buildPlan(input({checks: {status: 'ready', byLesson}, evidence: new Map([[AUTHZ.id, ASSISTED_CORRECT]])}))
    const checks = plan.items.filter((item) => item.kind === 'diagnose')
    assert.deepEqual(
      checks.map((item) => item.id),
      ['diagnose:lesson-1', 'diagnose:lesson-3'],
    )
    assert.equal(checks.length, MAX_CHECK_ITEMS)
    assert.equal(checks[0].href, '/lessons/authentication')
    assert.equal(checks[0].reason, 'You haven’t answered any questions on Authentication yet. This lesson’s check starts with it. The check covers 2 ideas.')
    assert.deepEqual(checks[0].provenance.check, {remaining: 2, total: 2})
    assert.ok(!plan.notices.includes('no_evidence_no_check'))
  })

  it('offers no check when the check route is off, and says the plan follows course order', () => {
    const plan = buildPlan(input({checks: {status: 'unavailable'}}))
    assert.ok(!plan.items.some((item) => item.kind === 'diagnose'))
    assert.ok(plan.notices.includes('no_evidence_no_check'))
  })
})

describe('buildPlan: continue, ordering, and bounds', () => {
  it('resumes the most recent started lesson at its stored second, and keeps one item per lesson', () => {
    const progress = [
      row('lesson-2', {resumeSeconds: 125.6, updatedAt: '2026-09-13T00:00:00Z'}),
      row('lesson-1', {resumeSeconds: 30, updatedAt: '2026-09-10T00:00:00Z'}),
    ]
    const plan = buildPlan(input({progress}))
    const [first] = plan.items
    assert.equal(first.id, 'continue:lesson-2')
    assert.equal(first.href, '/lessons/authorization?t=125')
    assert.equal(first.reason, 'You stopped at 2:05 1 day ago.')
    assert.equal(first.actionLabel, 'Resume at 2:05')
    assert.ok(!plan.items.some((item) => item.id === 'learn:cpt-authz'), 'the continued lesson is not also a learn item')
    assert.deepEqual(first.provenance.progress, {lessonId: 'lesson-2', resumeSeconds: 125.6, updatedAt: '2026-09-13T00:00:00Z'})
  })

  it('ignores a stored position beyond the lesson’s length', () => {
    const plan = buildPlan(input({progress: [row('lesson-1', {resumeSeconds: 9999})]}))
    assert.equal(plan.items[0].href, '/lessons/authentication')
    assert.equal(plan.items[0].actionLabel, 'Continue lesson')
  })

  it('is deterministic whatever order its inputs arrive in', () => {
    const edges = [edge('edge-1', 'cpt-authn', 'cpt-jwt'), edge('edge-2', 'cpt-authn', 'cpt-sessions')]
    const evidenceMap = new Map([[AUTHN.id, DEMONSTRATED]])
    const a = buildPlan(input({edges, evidence: evidenceMap}))
    const b = buildPlan(input({edges: edges.toReversed(), concepts: CONCEPTS.toReversed(), evidence: evidenceMap}))
    assert.deepEqual(a, b)
    assert.deepEqual(
      a.items.map((item) => item.id),
      ['learn:cpt-sessions', 'learn:cpt-jwt', 'next:lesson-1', 'learn:cpt-authz'],
    )
  })

  it('never returns more than the plan limit, and every item passes the response contract', () => {
    const lessons = Array.from({length: 8}, (_, i) => ({_id: `lesson-x${i}`, title: `Lesson ${i}`, slug: `lesson-x${i}`, number: i + 1, durationSeconds: 300}))
    const many = Array.from({length: 16}, (_, i) => concept(`cpt-extra-${i}`, `Extra ${i}`, `lesson-x${i % 8}`, 10 + i * 5))
    const course = {id: 'course-long', title: 'Long course', slug: 'long-course', lessons}
    const plan = buildPlan(input({course, concepts: many}))
    assert.equal(plan.items.length, PLAN_LIMIT)
    assert.equal(new Set(plan.items.map((item) => item.lesson?.id)).size, PLAN_LIMIT, 'one lesson-watch item per lesson')
    for (const item of plan.items) planItemSchema.parse(item)
  })
})

describe('conceptSpan', () => {
  const lessons = new Map(LESSONS.map((lesson) => [lesson._id, lesson]))
  const source = (start: number, end: number | null, lessonId = 'lesson-1', chunkId = `c-${start}`) => ({chunkId, lessonId, startSeconds: start, endSeconds: end})

  it('extends over contiguous cited chunks in the first lesson, and stops at a gap', () => {
    const span = conceptSpan([source(100, 130), source(10, 40), source(40, 70), source(71, 95), source(20, 60, 'lesson-2')], lessons)
    assert.deepEqual(span && {start: span.startSeconds, end: span.endSeconds, lesson: span.lesson._id, chunks: span.chunkIds}, {
      start: 10,
      end: 95,
      lesson: 'lesson-1',
      chunks: ['c-10', 'c-40', 'c-71'],
    })
  })

  it('drops times outside the lesson and clamps the end to its stored length', () => {
    assert.equal(conceptSpan([source(700, 720)], lessons), null)
    assert.deepEqual(conceptSpan([source(590, 640)], lessons)?.endSeconds, 600)
    assert.equal(conceptSpan([source(10, null)], lessons)?.endSeconds, null)
    assert.equal(conceptSpan([source(10, 20, 'lesson-unknown')], lessons), null)
  })
})
