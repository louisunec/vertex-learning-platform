import assert from 'node:assert/strict'
import {register} from 'node:module'
import {after, before, beforeEach, describe, it} from 'node:test'

import type postgres from 'postgres'

import type {CheckCandidate} from '../assessments/learner.ts'
import {createTestDatabase, SKIP_WITHOUT_DATABASE, type TestDatabase} from '../db/test-db.ts'
import {ContentUnavailableError} from './content-source.ts'
import {goalResponseSchema, nextActionResponseSchema} from './next-action-contracts.ts'
import type {GoalCourse, NextActionContentSource} from './next-action-source.ts'

/**
 * The real `app/api/next` and `app/api/goal` handlers, unchanged, with only
 * their external edges replaced (Clerk's `auth()`, the PostHog client behind
 * the real `lib/flags.ts`, the database handle, and the Sanity content
 * source), as in `review-route.db.test.ts`. Proves 401 before flags, 404
 * unless both `next-action` and `learner-evidence` are on (before any
 * content or database access), strict bodies, identity from the session
 * only, the delivery flags, and outages reported as retryable failures.
 */

type RouteState = {
  userId: string | null
  flagsOn: Set<string>
  flagChecks: string[][]
  dbCalls: number
  contentCalls: number
  db: postgres.Sql | null
  content: NextActionContentSource | null
}

const state: RouteState = {userId: null, flagsOn: new Set(), flagChecks: [], dbCalls: 0, contentCalls: 0, db: null, content: null}
Object.assign(globalThis, {__nextRoute: state})

const STUBS: Record<string, string> = {
  '@clerk/nextjs/server': `
    export async function auth() { return {userId: globalThis.__nextRoute.userId} }
  `,
  '@/lib/posthog-server': `
    export function getPostHogClient() {
      return {
        async evaluateFlags(distinctId, {flagKeys}) {
          const s = globalThis.__nextRoute
          s.flagChecks.push([distinctId, ...flagKeys])
          return {isEnabled: (key) => s.flagsOn.has(key)}
        },
      }
    }
  `,
  '@/lib/db/client': `
    export function getDb() { globalThis.__nextRoute.dbCalls++; return globalThis.__nextRoute.db }
  `,
  '@/lib/learner/next-action-content': `
    const s = () => globalThis.__nextRoute
    export const sanityNextActionContent = Object.fromEntries(
      [
        'loadConceptIndex', 'loadReviewCandidates', 'loadGoalCourses', 'loadCourse', 'loadProgress',
        'loadCourseConcepts', 'loadPrerequisiteEdges', 'loadCourseCheckCandidates',
      ].map((method) => [
        method,
        (...args) => { s().contentCalls++; return s().content[method](...args) },
      ]),
    )
  `,
}

const HOOKS = `
  const ROOT = ${JSON.stringify(new URL('../../', import.meta.url).href)}
  const STUBS = ${JSON.stringify(STUBS)}
  export async function resolve(specifier, context, next) {
    if (Object.hasOwn(STUBS, specifier)) return {url: 'vertex-stub:' + encodeURIComponent(specifier), shortCircuit: true}
    if (specifier.startsWith('@/')) return next(new URL(specifier.slice(2) + '.ts', ROOT).href, context)
    return next(specifier, context)
  }
  export async function load(url, context, next) {
    if (url.startsWith('vertex-stub:')) {
      return {format: 'module', source: STUBS[decodeURIComponent(url.slice('vertex-stub:'.length))], shortCircuit: true}
    }
    return next(url, context)
  }
`

const ALICE = 'user_alice'
const BOB = 'user_bob'
const BOTH = ['next-action', 'learner-evidence']
const COURSE = 'course-react'

const COURSE_DOC: GoalCourse = {
  _id: COURSE,
  title: 'React Foundations',
  slug: 'react-foundations',
  summary: null,
  lessons: [{_id: 'lesson-hooks', title: 'Hooks', slug: 'hooks', durationSeconds: 900}],
}

const CHECK_ITEM: CheckCandidate = {
  item: {
    _id: 'assessment-fam1-v1',
    _rev: 'rev-1',
    familyId: 'fam1',
    version: 1,
    lessonId: 'lesson-hooks',
    type: 'apply',
    responseFormat: 'single_choice',
    question: 'Which hook keeps a value between renders?',
    options: [
      {id: 'opt-a', text: 'useState'},
      {id: 'opt-b', text: 'useEffect'},
      {id: 'opt-c', text: 'useMemo'},
    ],
  },
  primaryConceptRef: 'concept-cpt-state',
  firstSeconds: 300,
}

function fixtureContent(fail = false): NextActionContentSource {
  const read = <T>(value: T) => async () => {
    if (fail) throw new ContentUnavailableError('Sanity is down')
    return value
  }
  return {
    loadConceptIndex: read(new Map([['concept-cpt-state', {id: 'concept-cpt-state', conceptId: 'cpt-state', reviewStatus: 'approved'}]])),
    loadReviewCandidates: read([]),
    loadGoalCourses: read([{_id: COURSE, title: COURSE_DOC.title, slug: COURSE_DOC.slug}]),
    loadCourse: async (courseId: string) => (courseId === COURSE ? COURSE_DOC : null),
    loadProgress: read([]),
    loadCourseConcepts: read([
      {
        id: 'concept-cpt-state',
        conceptId: 'cpt-state',
        name: 'Component state',
        sources: [{chunkId: 'v:tc-1', lessonId: 'lesson-hooks', startSeconds: 300, endSeconds: 330}],
      },
    ]),
    loadPrerequisiteEdges: read([]),
    loadCourseCheckCandidates: read([CHECK_ITEM]),
  }
}

describe('POST /api/next and /api/goal', {skip: SKIP_WITHOUT_DATABASE}, () => {
  let db: TestDatabase
  let nextRoute: (request: Request) => Promise<Response>
  let goalRoute: (request: Request) => Promise<Response>

  before(async () => {
    process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN = 'phc_test_only'
    register(`data:text/javascript,${encodeURIComponent(HOOKS)}`)
    db = await createTestDatabase()
    state.db = db.sql
    ;({POST: nextRoute} = await import('../../app/api/next/route.ts'))
    ;({POST: goalRoute} = await import('../../app/api/goal/route.ts'))
  })
  after(() => db?.drop())

  beforeEach(async () => {
    await db.sql`truncate learner.learning_goal`
    Object.assign(state, {userId: ALICE, flagsOn: new Set(), flagChecks: [], dbCalls: 0, contentCalls: 0, content: fixtureContent()})
  })

  const post = (route: (request: Request) => Promise<Response>, url: string, body: unknown) =>
    route(new Request(`http://localhost${url}`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)}))
  const next = (body: unknown = {}) => post(nextRoute, '/api/next', body)
  const goal = (body: unknown) => post(goalRoute, '/api/goal', body)
  const goals = async () => [
    ...(await db.sql<{learnerId: string; courseId: string}[]>`select learner_id as "learnerId", course_id as "courseId" from learner.learning_goal`),
  ]

  it('returns 404 to a signed-in learner unless both flags are on, with no content or database access', async () => {
    for (const on of [[], ['learner-evidence'], ['next-action'], ['review-session', 'lesson-integration']]) {
      Object.assign(state, {flagsOn: new Set(on), flagChecks: []})
      for (const response of [await next(), await goal({courseId: COURSE})]) {
        assert.equal(response.status, 404, on.join('+') || 'none')
        assert.deepEqual(await response.json(), {error: 'Not found', code: 'not_found', retryable: false})
        assert.equal(response.headers.get('cache-control'), 'no-store')
      }
      assert.ok(state.flagChecks.length > 0 && state.flagChecks.every(([distinctId]) => distinctId === ALICE))
    }
    assert.deepEqual([state.dbCalls, state.contentCalls, (await goals()).length], [0, 0, 0])
  })

  it('returns 401 when signed out, before evaluating any flag', async () => {
    Object.assign(state, {userId: null, flagsOn: new Set(BOTH)})
    assert.equal((await next()).status, 401)
    assert.equal((await goal({courseId: COURSE})).status, 401)
    assert.deepEqual([state.flagChecks.length, state.dbCalls, state.contentCalls], [0, 0, 0])
  })

  it('rejects bodies that name a learner or carry anything but a course id', async () => {
    state.flagsOn = new Set(BOTH)
    for (const body of [{userId: BOB}, {courseId: COURSE, learnerId: BOB}, {courseId: '../../etc'}, {state: 'recent_evidence'}, []]) {
      const response = await next(body)
      assert.equal(response.status, 400, JSON.stringify(body))
      assert.equal((await response.json()).code, 'invalid_request')
    }
    for (const body of [{}, {courseId: COURSE, userId: BOB}, {courseId: ''}, {courseIds: [COURSE]}]) {
      assert.equal((await goal(body)).status, 400, JSON.stringify(body))
    }
    assert.deepEqual([state.dbCalls, state.contentCalls, (await goals()).length], [0, 0, 0])
  })

  it('saves the signed-in learner’s own goal and plans from it; another learner has none', async () => {
    state.flagsOn = new Set(BOTH)
    const missing = await goal({courseId: 'course-unpublished'})
    assert.equal(missing.status, 404)
    assert.deepEqual(await goals(), [])

    const saved = await goal({courseId: COURSE})
    assert.equal(saved.status, 200)
    assert.equal(goalResponseSchema.parse(await saved.json()).course.slug, 'react-foundations')
    assert.deepEqual(await goals(), [{learnerId: ALICE, courseId: COURSE}])

    const planned = await next()
    assert.equal(planned.status, 200)
    const body = nextActionResponseSchema.parse(await planned.json())
    assert.equal(body.status, 'ready')
    assert.deepEqual(
      body.status === 'ready' && body.items.map((item) => item.id),
      ['learn:cpt-state'],
      'the check is not offered while lesson-integration is off',
    )

    state.flagsOn = new Set([...BOTH, 'lesson-integration'])
    const withChecks = nextActionResponseSchema.parse(await (await next()).json())
    assert.deepEqual(withChecks.status === 'ready' && withChecks.items.map((item) => item.id), ['diagnose:lesson-hooks', 'learn:cpt-state'])

    state.userId = BOB
    assert.deepEqual(await (await next()).json(), {status: 'no_goal'})
    assert.equal((await next({courseId: 'course-unpublished'})).status, 404)
  })

  it('reports a content outage as a retryable 503, never as an empty plan', async () => {
    state.flagsOn = new Set(BOTH)
    assert.equal((await goal({courseId: COURSE})).status, 200)
    state.content = fixtureContent(true)
    const response = await next()
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), {error: 'Temporarily unavailable, please retry', code: 'unavailable', retryable: true})
  })
})
