import assert from 'node:assert/strict'
import {register} from 'node:module'
import {after, before, beforeEach, describe, it} from 'node:test'

import type postgres from 'postgres'

import {createTestDatabase, SKIP_WITHOUT_DATABASE, type TestDatabase} from '../db/test-db.ts'
import type {LearnerContentSource} from './content-source.ts'
import {lessonCheckResponseSchema} from './contracts.ts'
import {FixtureContent} from './test-content.ts'

/**
 * The real `app/api/lesson-check/route.ts` handler, unchanged, with only its
 * external edges replaced (Clerk's `auth()`, the PostHog client behind the
 * real `lib/flags.ts`, the database handle, and the Sanity content source),
 * as in `help-route.db.test.ts`. Proves 401 before flags, 404 unless both
 * `learner-evidence` and `lesson-integration` are on (before any content or
 * database access), that the body cannot name an assessment or a learner,
 * and that the stubs are live.
 */

type RouteState = {
  userId: string | null
  flagsOn: Set<string>
  flagChecks: string[][]
  dbCalls: number
  contentCalls: number
  db: postgres.Sql | null
  content: LearnerContentSource | null
}

const state: RouteState = {userId: null, flagsOn: new Set(), flagChecks: [], dbCalls: 0, contentCalls: 0, db: null, content: null}
Object.assign(globalThis, {__lessonCheckRoute: state})

const STUBS: Record<string, string> = {
  '@clerk/nextjs/server': `
    export async function auth() { return {userId: globalThis.__lessonCheckRoute.userId} }
  `,
  '@/lib/posthog-server': `
    export function getPostHogClient() {
      return {
        async evaluateFlags(distinctId, {flagKeys}) {
          const s = globalThis.__lessonCheckRoute
          s.flagChecks.push([distinctId, ...flagKeys])
          return {isEnabled: (key) => s.flagsOn.has(key)}
        },
      }
    }
  `,
  '@/lib/db/client': `
    export function getDb() { globalThis.__lessonCheckRoute.dbCalls++; return globalThis.__lessonCheckRoute.db }
  `,
  '@/lib/learner/content': `
    const s = () => globalThis.__lessonCheckRoute
    export const sanityLearnerContent = Object.fromEntries(
      ['loadServableItem', 'loadGradingItem', 'loadHintLadder', 'loadConceptIndex', 'loadLessonCheckCandidates'].map((method) => [
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
const BOTH = ['learner-evidence', 'lesson-integration']

describe('POST /api/lesson-check gating', {skip: SKIP_WITHOUT_DATABASE}, () => {
  let db: TestDatabase
  let POST: (request: Request) => Promise<Response>

  before(async () => {
    process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN = 'phc_test_only'
    register(`data:text/javascript,${encodeURIComponent(HOOKS)}`)
    db = await createTestDatabase()
    state.db = db.sql
    ;({POST} = await import('../../app/api/lesson-check/route.ts'))
  })
  after(() => db?.drop())

  beforeEach(async () => {
    await db.sql`truncate learner.review_log, learner.review_card, learner.review_session_item, learner.review_session, learner.tutor_request, learner.event_outbox, learner.help_event, learner.attempt_log, learner.task_instance`
    const content = new FixtureContent()
    content.addItem('fam1')
    Object.assign(state, {userId: ALICE, flagsOn: new Set(), flagChecks: [], dbCalls: 0, contentCalls: 0, content})
  })

  const post = (body: unknown = {lessonId: 'lesson-hooks', kind: 'check'}) =>
    POST(
      new Request('http://localhost/api/lesson-check', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(body),
      }),
    )

  const instances = async () => (await db.sql<{n: number}[]>`select count(*)::int as n from learner.task_instance`)[0].n

  it('returns 404 to a signed-in learner unless both flags are on, with no content or database access', async () => {
    for (const on of [[], ['learner-evidence'], ['lesson-integration']]) {
      Object.assign(state, {flagsOn: new Set(on), flagChecks: []})
      const response = await post()
      assert.equal(response.status, 404, on.join('+') || 'none')
      assert.deepEqual(await response.json(), {error: 'Not found', code: 'not_found', retryable: false})
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.ok(state.flagChecks.length > 0 && state.flagChecks.every(([distinctId]) => distinctId === ALICE))
    }
    assert.deepEqual([state.dbCalls, state.contentCalls, await instances()], [0, 0, 0])
  })

  it('returns 401 when signed out, before evaluating any flag', async () => {
    Object.assign(state, {userId: null, flagsOn: new Set(BOTH)})
    assert.equal((await post()).status, 401)
    assert.deepEqual([state.flagChecks.length, state.dbCalls, state.contentCalls, await instances()], [0, 0, 0, 0])
  })

  it('rejects bodies that name an assessment or a learner, or a follow-up without its task', async () => {
    state.flagsOn = new Set(BOTH)
    for (const body of [
      {lessonId: 'lesson-hooks', kind: 'check', assessmentId: 'assessment-fam1-v1'},
      {lessonId: 'lesson-hooks', kind: 'check', userId: 'user_bob'},
      {lessonId: 'lesson-hooks', kind: 'follow_up'},
      {lessonId: 'lesson-hooks', kind: 'next'},
    ]) {
      const response = await post(body)
      assert.equal(response.status, 400, JSON.stringify(body))
      assert.equal((await response.json()).code, 'invalid_request')
    }
    assert.deepEqual([state.dbCalls, state.contentCalls, await instances()], [0, 0, 0])
  })

  it('issues a learner-safe question with both flags on, then resumes it', async () => {
    state.flagsOn = new Set(BOTH)
    const first = await post()
    assert.equal(first.status, 201)
    const body = lessonCheckResponseSchema.parse(await first.json())
    assert.equal(body.status === 'issued' && body.task.item.familyId, 'fam1')
    const again = await post()
    assert.equal(again.status, 200)
    assert.equal(lessonCheckResponseSchema.parse(await again.json()).status === 'issued', true)
    assert.ok(state.dbCalls > 0 && state.contentCalls > 0)
    assert.equal(await instances(), 1)
  })
})
