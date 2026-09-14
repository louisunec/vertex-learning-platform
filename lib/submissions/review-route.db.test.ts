import assert from 'node:assert/strict'
import {register} from 'node:module'
import {after, before, beforeEach, describe, it} from 'node:test'

import type {LanguageModel} from 'ai'
import type postgres from 'postgres'

import {createTestDatabase, SKIP_WITHOUT_DATABASE, type TestDatabase} from '../db/test-db.ts'
import {CONCATENATED, FixtureTaskSource, failingReviewModel, reviewModel} from './test-fixtures.ts'

/**
 * The real `app/api/review/route.ts` handler, unchanged, with only its
 * external edges replaced: Clerk's `auth()`, the PostHog client behind the
 * real `lib/flags.ts`, the database handle, the Sanity task source, and the
 * OpenAI provider. Proves identity, flag gating before any content or
 * database access, strict and bounded bodies, and outage handling that keeps
 * code out of logs.
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
Object.assign(globalThis, {__reviewRoute: state})

const STUBS: Record<string, string> = {
  '@clerk/nextjs/server': `
    export async function auth() { return {userId: globalThis.__reviewRoute.userId} }
  `,
  '@/lib/posthog-server': `
    export function getPostHogClient() {
      return {
        async evaluateFlags(distinctId, {flagKeys}) {
          const s = globalThis.__reviewRoute
          s.flagChecks.push([distinctId, ...flagKeys])
          return {isEnabled: (key) => s.flagsOn.has(key)}
        },
      }
    }
  `,
  '@/lib/db/client': `
    export function getDb() { globalThis.__reviewRoute.dbCalls++; return globalThis.__reviewRoute.db }
  `,
  '@/lib/submissions/sanity-source': `
    export const sanitySubmissionTaskSource = {
      loadLessonTask(lessonId) { const s = globalThis.__reviewRoute; s.contentCalls++; return s.source.loadLessonTask(lessonId) },
    }
  `,
  '@ai-sdk/openai': `
    export function openai() { return globalThis.__reviewRoute.model }
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
const ALL_FLAGS = ['learner-evidence', 'help-policy', 'submission-review']

describe('POST /api/review', {skip: SKIP_WITHOUT_DATABASE}, () => {
  let db: TestDatabase
  let POST: (request: Request) => Promise<Response>

  before(async () => {
    process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN = 'phc_test_only'
    process.env.OPENAI_API_KEY = 'sk-test-only'
    register(`data:text/javascript,${encodeURIComponent(HOOKS)}`)
    db = await createTestDatabase()
    state.db = db.sql
    ;({POST} = await import('../../app/api/review/route.ts'))
  })
  after(() => db?.drop())

  beforeEach(async () => {
    await db.sql`truncate learner.submission_log, learner.submission_review, learner.tutor_request, learner.event_outbox, learner.help_event`
    Object.assign(state, {userId: ALICE, flagsOn: new Set(ALL_FLAGS), flagChecks: [], dbCalls: 0, contentCalls: 0, source: new FixtureTaskSource(), model: reviewModel()})
  })

  const reviewBody = (overrides: Record<string, unknown> = {}) => ({
    action: 'review',
    lessonId: 'lesson-sql',
    taskId: 'sql-user-lookup',
    taskVersion: 1,
    submission: {type: 'snippet', content: CONCATENATED},
    requestKey: 'review-key-0123456789',
    ...overrides,
  })

  const post = (body: unknown) =>
    POST(new Request('http://localhost/api/review', {method: 'POST', headers: {'content-type': 'application/json'}, body: typeof body === 'string' ? body : JSON.stringify(body)}))

  const rows = async () => {
    const [row] = await db.sql<{reviews: number; logs: number; help: number}[]>`
      select
        (select count(*)::int from learner.submission_review) as reviews,
        (select count(*)::int from learner.submission_log) as logs,
        (select count(*)::int from learner.help_event) as help
    `
    return row
  }

  it('returns 401 when signed out, before evaluating any flag', async () => {
    state.userId = null
    const response = await post(reviewBody())
    assert.equal(response.status, 401)
    assert.deepEqual([state.flagChecks.length, state.dbCalls, state.contentCalls], [0, 0, 0])
  })

  it('returns 404 unless all three flags are on, with no content or database access', async () => {
    for (const on of [[], ['learner-evidence', 'help-policy'], ['learner-evidence', 'submission-review'], ['help-policy', 'submission-review']]) {
      Object.assign(state, {flagsOn: new Set(on), flagChecks: []})
      const response = await post(reviewBody())
      assert.equal(response.status, 404, on.join('+') || 'none')
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.ok(state.flagChecks.every(([distinctId]) => distinctId === ALICE))
    }
    assert.deepEqual([state.dbCalls, state.contentCalls], [0, 0])
    assert.deepEqual(await rows(), {reviews: 0, logs: 0, help: 0})
  })

  it('rejects a client-supplied identity or level, malformed JSON, and oversized bodies', async () => {
    for (const body of [reviewBody({userId: 'user_bob'}), reviewBody({helpLevel: 3}), '{not json', {action: 'help', reviewId: 'x', request: 'solution', requestKey: 'k'.repeat(20)}]) {
      assert.equal((await post(body)).status, 400)
    }
    const huge = await post(reviewBody({submission: {type: 'snippet', content: 'x'.repeat(60_000)}}))
    assert.equal(huge.status, 413)
    const tooManyLines = await post(reviewBody({submission: {type: 'snippet', content: Array(201).fill('x').join('\n')}}))
    assert.equal(tooManyLines.status, 413)
    assert.deepEqual([state.contentCalls, await rows()], [0, {reviews: 0, logs: 0, help: 0}])
  })

  it('reviews as the signed-in learner, replays a retry, and gives more help on request', async () => {
    const first = await post(reviewBody())
    assert.equal(first.status, 201)
    assert.equal(first.headers.get('cache-control'), 'no-store')
    const body = await first.json()
    assert.deepEqual([body.outcome, body.help.level, body.findings[0].lines.start], ['changes_suggested', 1, 2])
    const [owner] = await db.sql`select learner_id from learner.submission_log`
    assert.equal(owner.learner_id, ALICE)

    const retry = await post(reviewBody())
    assert.deepEqual([retry.status, retry.headers.get('idempotent-replayed')], [200, 'true'])

    const more = await post({action: 'help', reviewId: body.reviewId, request: 'escalate', requestKey: 'help-key-0123456789ab'})
    assert.equal(more.status, 201)
    assert.equal((await more.json()).help.level, 2)
  })

  it('answers a provider failure with a retryable 503 and never logs the code', async () => {
    state.model = failingReviewModel()
    const logged: string[] = []
    const original = {error: console.error, warn: console.warn, info: console.info}
    console.error = console.warn = console.info = (...args: unknown[]) => void logged.push(args.map(String).join(' '))
    try {
      const response = await post(reviewBody())
      assert.equal(response.status, 503)
      assert.deepEqual(await response.json(), {error: 'Temporarily unavailable, please retry', code: 'unavailable', retryable: true})
    } finally {
      Object.assign(console, original)
    }
    assert.ok(logged.length > 0)
    for (const line of logged) assert.ok(!line.includes('SELECT') && !line.includes('username'), line)
    assert.deepEqual(await rows(), {reviews: 1, logs: 0, help: 0})
  })

  it('answers a content outage with a retryable 503', async () => {
    state.source!.fail = true
    const original = console.error
    console.error = () => {}
    try {
      assert.equal((await post(reviewBody())).status, 503)
    } finally {
      console.error = original
    }
  })

  it('answers a concurrent identical review with a retryable 409', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const model = reviewModel({gate: () => held})
    state.model = model
    const first = post(reviewBody())
    while (model.reviewCalls === 0) await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await post(reviewBody({requestKey: 'review-key-other-0123'}))
    assert.equal(second.status, 409)
    assert.deepEqual(await second.json(), {error: 'This code is already being reviewed; retry shortly', code: 'review_in_progress', retryable: true})
    release()
    assert.equal((await first).status, 201)
  })
})
