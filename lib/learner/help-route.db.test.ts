import assert from 'node:assert/strict'
import {register} from 'node:module'
import {after, before, beforeEach, describe, it} from 'node:test'

import type postgres from 'postgres'

import {createTestDatabase, SKIP_WITHOUT_DATABASE, type TestDatabase} from '../db/test-db.ts'
import type {LearnerContentSource} from './content-source.ts'
import {issueTask} from './task-instances.ts'
import {FixtureContent} from './test-content.ts'

/**
 * The real `app/api/help/route.ts` handler, unchanged, with only its
 * external edges replaced: Clerk's `auth()`, the PostHog client behind the
 * real `lib/flags.ts`, the database handle, and the Sanity content source.
 * Proves that a signed-in learner gets 404 unless both `learner-evidence`
 * and `help-policy` are on, before any content read or database access, and
 * that the stubs are live (both flags on reaches the policy and records).
 *
 * The module hooks only affect this file's test process.
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
Object.assign(globalThis, {__helpRoute: state})

const STUBS: Record<string, string> = {
  '@clerk/nextjs/server': `
    export async function auth() { return {userId: globalThis.__helpRoute.userId} }
  `,
  '@/lib/posthog-server': `
    export function getPostHogClient() {
      return {
        async evaluateFlags(distinctId, {flagKeys}) {
          const s = globalThis.__helpRoute
          s.flagChecks.push([distinctId, ...flagKeys])
          return {isEnabled: (key) => s.flagsOn.has(key)}
        },
      }
    }
  `,
  '@/lib/db/client': `
    export function getDb() { globalThis.__helpRoute.dbCalls++; return globalThis.__helpRoute.db }
  `,
  '@/lib/learner/content': `
    const s = () => globalThis.__helpRoute
    export const sanityLearnerContent = Object.fromEntries(
      ['loadServableItem', 'loadGradingItem', 'loadHintLadder', 'loadConceptIndex'].map((method) => [
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
const NOW = new Date('2026-09-13T10:00:00.000Z')

describe('POST /api/help gating', {skip: SKIP_WITHOUT_DATABASE}, () => {
  let db: TestDatabase
  let content: FixtureContent
  let POST: (request: Request) => Promise<Response>
  let taskInstanceId: string

  before(async () => {
    process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN = 'phc_test_only'
    register(`data:text/javascript,${encodeURIComponent(HOOKS)}`)
    db = await createTestDatabase()
    state.db = db.sql
    ;({POST} = await import('../../app/api/help/route.ts'))
  })
  after(() => db?.drop())

  beforeEach(async () => {
    await db.sql`truncate learner.review_log, learner.review_card, learner.review_session_item, learner.review_session, learner.tutor_request, learner.event_outbox, learner.help_event, learner.attempt_log, learner.task_instance`
    content = new FixtureContent()
    const issued = await issueTask({db: db.sql, content, learnerId: ALICE, assessmentId: content.addItem('fam1'), now: NOW})
    assert.equal(issued.status, 'issued')
    taskInstanceId = issued.status === 'issued' ? issued.body.taskInstanceId : ''
    Object.assign(state, {userId: ALICE, flagsOn: new Set(), flagChecks: [], dbCalls: 0, contentCalls: 0, content})
  })

  const post = () =>
    POST(
      new Request('http://localhost/api/help', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({taskInstanceId, mode: 'reference', request: 'solution', requestKey: 'key-0123456789abcdef'}),
      }),
    )

  const writes = async () => {
    const [row] = await db.sql<{instances: number; events: number; outbox: number; attempts: number}[]>`
      select
        (select count(*)::int from learner.task_instance) as instances,
        (select count(*)::int from learner.help_event) as events,
        (select count(*)::int from learner.event_outbox) as outbox,
        (select count(*)::int from learner.attempt_log) as attempts
    `
    return row
  }

  it('returns 404 to a signed-in learner unless both flags are on, with no content or database access', async () => {
    for (const on of [[], ['learner-evidence'], ['help-policy']]) {
      Object.assign(state, {flagsOn: new Set(on), flagChecks: []})
      const response = await post()
      assert.equal(response.status, 404, on.join('+') || 'none')
      assert.deepEqual(await response.json(), {error: 'Not found', code: 'not_found', retryable: false})
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.ok(state.flagChecks.length > 0 && state.flagChecks.every(([distinctId]) => distinctId === ALICE))
    }
    assert.deepEqual([state.dbCalls, state.contentCalls], [0, 0])
    assert.deepEqual(await writes(), {instances: 1, events: 0, outbox: 0, attempts: 0})
  })

  it('returns 401 when signed out, before evaluating any flag', async () => {
    Object.assign(state, {userId: null, flagsOn: new Set(['learner-evidence', 'help-policy'])})
    assert.equal((await post()).status, 401)
    assert.deepEqual([state.flagChecks.length, state.dbCalls, state.contentCalls], [0, 0, 0])
    assert.deepEqual(await writes(), {instances: 1, events: 0, outbox: 0, attempts: 0})
  })

  it('reaches the help policy only with both flags on', async () => {
    state.flagsOn = new Set(['learner-evidence', 'help-policy'])
    const response = await post()
    assert.equal(response.status, 201)
    const body = await response.json()
    assert.deepEqual([body.level, body.reasonCode, body.hint.correctOptionId], [3, 'reference_mode', 'opt-a'])
    assert.ok(state.dbCalls > 0 && state.contentCalls > 0)
    assert.deepEqual(await writes(), {instances: 1, events: 1, outbox: 1, attempts: 0})
  })
})
