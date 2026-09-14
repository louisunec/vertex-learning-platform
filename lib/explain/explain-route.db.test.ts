import assert from 'node:assert/strict'
import {register} from 'node:module'
import {after, before, beforeEach, describe, it} from 'node:test'

import type {LanguageModel} from 'ai'
import type postgres from 'postgres'

import {createTestDatabase, SKIP_WITHOUT_DATABASE, type TestDatabase} from '../db/test-db.ts'
import {explainModel, failingExplainModel, FixtureTaskSource, RISE_ONLY, FIXTURE_LESSON} from './test-fixtures.ts'

/**
 * The real `app/api/explain/route.ts` handler, unchanged, with only its
 * external edges replaced: Clerk's `auth()`, the PostHog client behind the
 * real `lib/flags.ts`, the database handle, the Sanity task source, and the
 * OpenAI provider. Proves identity, flag gating before any content or
 * database access, strict and bounded bodies, and outage handling that keeps
 * the learner's text out of logs.
 */

type RouteState = {
  userId: string | null
  flagsOn: Set<string>
  flagChecks: string[][]
  dbCalls: number
  contentCalls: number
  db: postgres.Sql | null
  source: FixtureTaskSource | null
  model: LanguageModel | null
}

const state: RouteState = {userId: null, flagsOn: new Set(), flagChecks: [], dbCalls: 0, contentCalls: 0, db: null, source: null, model: null}
Object.assign(globalThis, {__explainRoute: state})

const STUBS: Record<string, string> = {
  '@clerk/nextjs/server': `
    export async function auth() { return {userId: globalThis.__explainRoute.userId} }
  `,
  '@/lib/posthog-server': `
    export function getPostHogClient() {
      return {
        async evaluateFlags(distinctId, {flagKeys}) {
          const s = globalThis.__explainRoute
          s.flagChecks.push([distinctId, ...flagKeys])
          return {isEnabled: (key) => s.flagsOn.has(key)}
        },
      }
    }
  `,
  '@/lib/db/client': `
    export function getDb() { globalThis.__explainRoute.dbCalls++; return globalThis.__explainRoute.db }
  `,
  '@/lib/explain/sanity-source': `
    export const sanityExplanationTaskSource = {
      loadLessonTask(lessonId) { const s = globalThis.__explainRoute; s.contentCalls++; return s.source.loadLessonTask(lessonId) },
    }
  `,
  '@ai-sdk/openai': `
    export function openai() { return globalThis.__explainRoute.model }
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
const ALL_FLAGS = ['learner-evidence', 'explain-back']

describe('POST /api/explain', {skip: SKIP_WITHOUT_DATABASE}, () => {
  let db: TestDatabase
  let POST: (request: Request) => Promise<Response>

  before(async () => {
    process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN = 'phc_test_only'
    process.env.OPENAI_API_KEY = 'sk-test-only'
    register(`data:text/javascript,${encodeURIComponent(HOOKS)}`)
    db = await createTestDatabase()
    state.db = db.sql
    ;({POST} = await import('../../app/api/explain/route.ts'))
  })
  after(() => db?.drop())

  beforeEach(async () => {
    await db.sql`truncate learner.explanation_log, learner.event_outbox cascade`
    Object.assign(state, {userId: ALICE, flagsOn: new Set(ALL_FLAGS), flagChecks: [], dbCalls: 0, contentCalls: 0, source: new FixtureTaskSource(), model: explainModel()})
  })

  const body = (overrides: Record<string, unknown> = {}) => ({
    lessonId: FIXTURE_LESSON.id,
    taskId: 'dough-rise-and-set',
    taskVersion: 1,
    text: RISE_ONLY,
    idempotencyKey: 'explain-key-0123456789',
    ...overrides,
  })

  const post = (payload: unknown) =>
    POST(new Request('http://localhost/api/explain', {method: 'POST', headers: {'content-type': 'application/json'}, body: typeof payload === 'string' ? payload : JSON.stringify(payload)}))

  const rows = async () => {
    const [row] = await db.sql<{explanations: number}[]>`select count(*)::int as explanations from learner.explanation_log`
    return row.explanations
  }

  it('returns 401 when signed out, before evaluating any flag', async () => {
    state.userId = null
    const response = await post(body())
    assert.equal(response.status, 401)
    assert.deepEqual([state.flagChecks.length, state.dbCalls, state.contentCalls], [0, 0, 0])
  })

  it('returns 404 unless both flags are on, with no content or database access', async () => {
    for (const on of [[], ['learner-evidence'], ['explain-back'], ['explain-back', 'lesson-integration', 'tutor', 'help-policy']]) {
      Object.assign(state, {flagsOn: new Set(on), flagChecks: []})
      const response = await post(body())
      assert.equal(response.status, 404, on.join('+') || 'none')
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.ok(state.flagChecks.every(([distinctId]) => distinctId === ALICE))
    }
    assert.deepEqual([state.dbCalls, state.contentCalls, await rows()], [0, 0, 0])
  })

  it('needs neither the tutor, help-policy, lesson-integration, nor submission-review flag', async () => {
    const response = await post(body())
    assert.equal(response.status, 201)
    const checked = new Set(state.flagChecks.flatMap(([, ...keys]) => keys))
    assert.deepEqual([...checked].toSorted(), ['explain-back', 'learner-evidence'])
  })

  it('rejects a client-supplied identity, status, or score, malformed JSON, and oversized bodies', async () => {
    for (const payload of [body({userId: 'user_bob'}), body({status: 'demonstrated'}), body({score: 1}), body({revisionOf: '00000000-0000-4000-8000-000000000000'}), '{not json', body({idempotencyKey: 'short'})]) {
      assert.equal((await post(payload)).status, 400)
    }
    assert.equal((await post(body({text: 'x'.repeat(20_000)}))).status, 413)
    assert.equal((await post(body({text: 'y'.repeat(1501)}))).status, 413)
    assert.equal((await post(body({text: 'short'}))).status, 400)
    assert.deepEqual([state.contentCalls, await rows()], [0, 0])
  })

  it('evaluates as the signed-in learner and replays a retry', async () => {
    const first = await post(body())
    assert.equal(first.status, 201)
    assert.equal(first.headers.get('cache-control'), 'no-store')
    const json = await first.json()
    assert.deepEqual([json.outcome, json.criteria[0].status, json.attempt.evidence.kind], ['assessed', 'demonstrated', 'independent'])
    const [owner] = await db.sql`select learner_id from learner.explanation_log`
    assert.equal(owner.learner_id, ALICE)

    const retry = await post(body())
    assert.deepEqual([retry.status, retry.headers.get('idempotent-replayed')], [200, 'true'])
    assert.equal((await retry.json()).explanationId, json.explanationId)
    assert.equal((await post(body({text: `${RISE_ONLY} More.`}))).status, 409)
  })

  it('answers a provider failure with a retryable 503, never logs the text, and keeps it for the retry', async () => {
    state.model = failingExplainModel()
    const logged: string[] = []
    const original = {error: console.error, warn: console.warn, info: console.info}
    console.error = console.warn = console.info = (...args: unknown[]) => void logged.push(args.map(String).join(' '))
    try {
      const response = await post(body())
      assert.equal(response.status, 503)
      assert.deepEqual(await response.json(), {error: 'Temporarily unavailable, please retry', code: 'unavailable', retryable: true})
    } finally {
      Object.assign(console, original)
    }
    assert.ok(logged.length > 0)
    for (const line of logged) assert.ok(!line.includes('yeast feeds') && !line.includes('gluten traps'), line)
    const [row] = await db.sql`select evaluation_status from learner.explanation_log`
    assert.equal(row.evaluation_status, 'failed')

    state.model = explainModel()
    assert.equal((await post(body())).status, 201)
  })

  it('answers a content outage with a retryable 503, and a withdrawn version with 409', async () => {
    state.source!.fail = true
    const original = console.error
    console.error = () => {}
    try {
      assert.equal((await post(body())).status, 503)
    } finally {
      console.error = original
    }
    state.source!.fail = false
    const stale = await post(body({taskVersion: 2}))
    assert.deepEqual([stale.status, (await stale.json()).code], [409, 'task_unavailable'])
  })

  it('answers a concurrent retry of the same key with a retryable 409', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const model = explainModel({gate: () => held})
    state.model = model
    const first = post(body())
    while (model.calls === 0) await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await post(body())
    assert.equal(second.status, 409)
    assert.deepEqual(await second.json(), {error: 'This explanation is already being read; retry shortly', code: 'explanation_in_progress', retryable: true})
    release()
    assert.equal((await first).status, 201)
    assert.equal(await rows(), 1)
  })
})
