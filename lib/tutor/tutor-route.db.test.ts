import assert from 'node:assert/strict'
import {register} from 'node:module'
import {after, before, beforeEach, describe, it} from 'node:test'

import type postgres from 'postgres'

import {createTestDatabase, SKIP_WITHOUT_DATABASE, type TestDatabase} from '../db/test-db.ts'
import type {TutorSource} from './source.ts'
import {citingModel, FixtureTutorSource} from './test-source.ts'

/**
 * The real `app/api/tutor/route.ts` handler, unchanged, with only its
 * external edges replaced: Clerk's `auth()`, the PostHog client behind the
 * real `lib/flags.ts`, the database handle, the Sanity tutor source, and the
 * OpenAI provider. Proves that a signed-in learner gets 404 unless all of
 * `learner-evidence`, `help-policy`, and `tutor` are on, before any content
 * read, database access, or model call, and that the stubs are live.
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
  source: TutorSource | null
  model: ReturnType<typeof citingModel> | null
}

const state: RouteState = {userId: null, flagsOn: new Set(), flagChecks: [], dbCalls: 0, contentCalls: 0, db: null, source: null, model: null}
Object.assign(globalThis, {__tutorRoute: state})

const STUBS: Record<string, string> = {
  '@clerk/nextjs/server': `
    export async function auth() { return {userId: globalThis.__tutorRoute.userId} }
  `,
  '@/lib/posthog-server': `
    export function getPostHogClient() {
      return {
        async evaluateFlags(distinctId, {flagKeys}) {
          const s = globalThis.__tutorRoute
          s.flagChecks.push([distinctId, ...flagKeys])
          return {isEnabled: (key) => s.flagsOn.has(key)}
        },
      }
    }
  `,
  '@/lib/db/client': `
    export function getDb() { globalThis.__tutorRoute.dbCalls++; return globalThis.__tutorRoute.db }
  `,
  '@/lib/tutor/sanity-source': `
    const s = () => globalThis.__tutorRoute
    export const sanityTutorSource = Object.fromEntries(
      ['loadLesson', 'loadVideos', 'loadWindow', 'searchChunks'].map((method) => [
        method,
        (...args) => { s().contentCalls++; return s().source[method](...args) },
      ]),
    )
  `,
  '@ai-sdk/openai': `
    export function openai() { return globalThis.__tutorRoute.model }
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
const ALL_FLAGS = ['learner-evidence', 'help-policy', 'tutor']

describe('POST /api/tutor gating', {skip: SKIP_WITHOUT_DATABASE}, () => {
  let db: TestDatabase
  let POST: (request: Request) => Promise<Response>

  before(async () => {
    process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN = 'phc_test_only'
    process.env.OPENAI_API_KEY = 'sk-test-only'
    register(`data:text/javascript,${encodeURIComponent(HOOKS)}`)
    db = await createTestDatabase()
    state.db = db.sql
    ;({POST} = await import('../../app/api/tutor/route.ts'))
  })
  after(() => db?.drop())

  beforeEach(async () => {
    await db.sql`truncate learner.tutor_request, learner.event_outbox, learner.help_event, learner.attempt_log, learner.task_instance`
    Object.assign(state, {
      userId: ALICE,
      flagsOn: new Set(),
      flagChecks: [],
      dbCalls: 0,
      contentCalls: 0,
      source: new FixtureTutorSource(),
      model: citingModel(),
    })
  })

  const post = (body: unknown = {lessonId: 'lesson-hooks', currentSeconds: 110, question: 'What does useState return?', mode: 'study', requestKey: 'key-0123456789abcdef'}) =>
    POST(
      new Request('http://localhost/api/tutor', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(body),
      }),
    )

  const writes = async () => {
    const [row] = await db.sql<{requests: number; events: number; outbox: number}[]>`
      select
        (select count(*)::int from learner.tutor_request) as requests,
        (select count(*)::int from learner.help_event) as events,
        (select count(*)::int from learner.event_outbox) as outbox
    `
    return {...row}
  }

  it('returns 404 to a signed-in learner unless all three flags are on, with no content, database, or model access', async () => {
    for (const on of [[], ['learner-evidence', 'help-policy'], ['learner-evidence', 'tutor'], ['help-policy', 'tutor'], ['tutor']]) {
      Object.assign(state, {flagsOn: new Set(on), flagChecks: []})
      const response = await post()
      assert.equal(response.status, 404, on.join('+') || 'none')
      assert.deepEqual(await response.json(), {error: 'Not found', code: 'not_found', retryable: false})
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.ok(state.flagChecks.length > 0 && state.flagChecks.every(([distinctId]) => distinctId === ALICE))
    }
    assert.deepEqual([state.dbCalls, state.contentCalls, state.model?.calls], [0, 0, 0])
    assert.deepEqual(await writes(), {requests: 0, events: 0, outbox: 0})
  })

  it('returns 401 when signed out, before evaluating any flag', async () => {
    Object.assign(state, {userId: null, flagsOn: new Set(ALL_FLAGS)})
    assert.equal((await post()).status, 401)
    assert.deepEqual([state.flagChecks.length, state.dbCalls, state.contentCalls, state.model?.calls], [0, 0, 0, 0])
  })

  it('rejects a forged help level or learner id before any access', async () => {
    state.flagsOn = new Set(ALL_FLAGS)
    for (const forged of [{level: 3}, {userId: 'user_other'}, {helpLevel: 0}]) {
      const response = await post({lessonId: 'lesson-hooks', currentSeconds: 110, question: 'What is useState?', mode: 'study', requestKey: 'key-0123456789abcdef', ...forged})
      assert.equal(response.status, 400, JSON.stringify(forged))
    }
    assert.deepEqual([state.dbCalls, state.contentCalls], [0, 0])
  })

  it('reaches the tutor only with all three flags on', async () => {
    state.flagsOn = new Set(ALL_FLAGS)
    const response = await post()
    assert.equal(response.status, 201)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const body = await response.json()
    assert.deepEqual([body.status, body.scope, body.help.level], ['supported', 'window', 1])
    assert.ok(state.dbCalls > 0 && state.contentCalls > 0)
    assert.equal(state.model?.calls, 1)
    assert.deepEqual(await writes(), {requests: 1, events: 1, outbox: 2})

    const replay = await post()
    assert.equal(replay.status, 409)
    assert.equal((await replay.json()).code, 'already_answered')
  })

  it('reports a provider failure as a retryable 503 and records nothing', async () => {
    state.flagsOn = new Set(ALL_FLAGS)
    delete process.env.OPENAI_API_KEY
    try {
      const response = await post()
      assert.equal(response.status, 503)
      assert.deepEqual(await response.json(), {error: 'Temporarily unavailable, please retry', code: 'unavailable', retryable: true})
    } finally {
      process.env.OPENAI_API_KEY = 'sk-test-only'
    }
    assert.deepEqual(await writes(), {requests: 0, events: 0, outbox: 0})
  })
})
