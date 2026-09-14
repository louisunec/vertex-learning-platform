import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {register} from 'node:module'
import {after, before, beforeEach, describe, it} from 'node:test'

import type postgres from 'postgres'

import {createTestDatabase, SKIP_WITHOUT_DATABASE, type TestDatabase} from '../db/test-db.ts'
import type {LearnerContentSource} from './content-source.ts'
import {attemptResultSchema, reviewRefresherResponseSchema, reviewSessionResponseSchema} from './contracts.ts'
import {issueTask} from './task-instances.ts'
import {FixtureContent} from './test-content.ts'

/**
 * The real `app/api/review-session` handlers, unchanged, with only their
 * external edges replaced (Clerk's `auth()`, the PostHog client behind the
 * real `lib/flags.ts`, the database handle, and the Sanity content source),
 * as in `help-route.db.test.ts`. Proves 401 before flags, 404 unless both
 * `learner-evidence` and `review-session` are on (before any content or
 * database access), strict bodies, and that the stubs are live.
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
  '@/lib/learner/content': `
    const s = () => globalThis.__reviewRoute
    export const sanityLearnerContent = Object.fromEntries(
      [
        'loadServableItem', 'loadGradingItem', 'loadHintLadder', 'loadConceptIndex',
        'loadReviewCandidates', 'loadConceptNames', 'loadLessons',
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
const BOTH = ['learner-evidence', 'review-session']

describe('POST /api/review-session and /refresher gating', {skip: SKIP_WITHOUT_DATABASE}, () => {
  let db: TestDatabase
  let startRoute: (request: Request) => Promise<Response>
  let refresherRoute: (request: Request) => Promise<Response>
  let attemptsRoute: (request: Request) => Promise<Response>

  before(async () => {
    process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN = 'phc_test_only'
    register(`data:text/javascript,${encodeURIComponent(HOOKS)}`)
    db = await createTestDatabase()
    state.db = db.sql
    ;({POST: startRoute} = await import('../../app/api/review-session/route.ts'))
    ;({POST: refresherRoute} = await import('../../app/api/review-session/refresher/route.ts'))
    ;({POST: attemptsRoute} = await import('../../app/api/attempts/route.ts'))
  })
  after(() => db?.drop())

  beforeEach(async () => {
    await db.sql`
      truncate learner.review_log, learner.review_card, learner.review_session_item, learner.review_session, learner.tutor_request, learner.event_outbox,
               learner.help_event, learner.concept_mastery, learner.attempt_log, learner.task_instance
    `
    const content = new FixtureContent()
    content.concepts.set('concept-cpt-state', {id: 'concept-cpt-state', conceptId: 'cpt-state', reviewStatus: 'approved'})
    content.addItem('fam1')
    content.addItem('fam2')
    Object.assign(state, {userId: ALICE, flagsOn: new Set(), flagChecks: [], dbCalls: 0, contentCalls: 0, content})
  })

  const post = (route: (request: Request) => Promise<Response>, url: string, body: unknown) =>
    route(new Request(`http://localhost${url}`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)}))
  const start = (body: unknown = {}) => post(startRoute, '/api/review-session', body)
  const refresher = (body: unknown) => post(refresherRoute, '/api/review-session/refresher', body)
  const validRefresher = () => ({taskInstanceId: randomUUID(), requestKey: randomUUID()})

  const sessions = async () => (await db.sql<{n: number}[]>`select count(*)::int as n from learner.review_session`)[0].n

  /** One wrong first answer on fam1, recorded directly as the superuser. */
  async function seedMistake() {
    const [instance] = await db.sql<{id: string}[]>`
      insert into learner.task_instance
        (learner_id, assessment_id, family_id, assessment_version, lesson_id, delivered_option_ids, expires_at)
      values (${ALICE}, 'assessment-fam1-v1', 'fam1', 1, 'lesson-hooks', ${db.sql.array(['opt-a', 'opt-b', 'opt-c'])}, now() + interval '1 day')
      returning id
    `
    await db.sql`
      insert into learner.attempt_log
        (learner_id, task_instance_id, assessment_id, family_id, assessment_version, selected_option_id, correct,
         hint_level_used, answer_exposed, evidence_kind, evidence_reason, resolved_concept_id, concept_resolution,
         policy_version, idempotency_key, request_hash)
      values (${ALICE}, ${instance.id}, 'assessment-fam1-v1', 'fam1', 1, 'opt-b', false, 0, false, 'independent',
              'first_independent_response', 'cpt-state', 'active', 'evidence-v1', ${randomUUID()}, 'hash')
    `
  }

  it('returns 404 to a signed-in learner unless both flags are on, with no content or database access', async () => {
    for (const on of [[], ['learner-evidence'], ['review-session']]) {
      Object.assign(state, {flagsOn: new Set(on), flagChecks: []})
      for (const response of [await start(), await refresher(validRefresher())]) {
        assert.equal(response.status, 404, on.join('+') || 'none')
        assert.deepEqual(await response.json(), {error: 'Not found', code: 'not_found', retryable: false})
        assert.equal(response.headers.get('cache-control'), 'no-store')
      }
      assert.ok(state.flagChecks.length > 0 && state.flagChecks.every(([distinctId]) => distinctId === ALICE))
    }
    assert.deepEqual([state.dbCalls, state.contentCalls, await sessions()], [0, 0, 0])
  })

  it('returns 401 when signed out, before evaluating any flag', async () => {
    Object.assign(state, {userId: null, flagsOn: new Set(BOTH)})
    assert.equal((await start()).status, 401)
    assert.equal((await refresher(validRefresher())).status, 401)
    assert.deepEqual([state.flagChecks.length, state.dbCalls, state.contentCalls], [0, 0, 0])
  })

  it('rejects bodies that name a learner, concept, or assessment', async () => {
    state.flagsOn = new Set(BOTH)
    for (const body of [{userId: 'user_bob'}, {conceptId: 'cpt-state'}, {assessmentId: 'assessment-fam1-v1'}, []]) {
      const response = await start(body)
      assert.equal(response.status, 400, JSON.stringify(body))
      assert.equal((await response.json()).code, 'invalid_request')
    }
    for (const body of [{taskInstanceId: randomUUID()}, {...validRefresher(), level: 0}, {...validRefresher(), requestKey: 'short'}]) {
      assert.equal((await refresher(body)).status, 400, JSON.stringify(body))
    }
    assert.deepEqual([state.dbCalls, state.contentCalls, await sessions()], [0, 0, 0])
  })

  it('starts a session with both flags on, resumes it, and records its refresher once', async () => {
    state.flagsOn = new Set(BOTH)
    const empty = await start()
    assert.equal(empty.status, 200)
    assert.deepEqual(await empty.json(), {status: 'none', reason: 'no_recent_mistakes'})

    await seedMistake()
    const created = await start()
    assert.equal(created.status, 201)
    const body = reviewSessionResponseSchema.parse(await created.json())
    const again = await start()
    assert.equal(again.status, 200)
    assert.equal(reviewSessionResponseSchema.parse(await again.json()).status, 'active')
    assert.equal(await sessions(), 1)

    const item = body.status === 'active' ? body.items[0] : assert.fail('no session')
    const request = {taskInstanceId: item.state === 'open' ? item.task.taskInstanceId : '', requestKey: randomUUID()}
    const opened = await refresher(request)
    assert.equal(opened.status, 201)
    assert.equal(reviewRefresherResponseSchema.parse(await opened.json()).href, '/lessons/hooks?t=341')
    const replay = await refresher(request)
    assert.equal(replay.status, 200)
    assert.equal(replay.headers.get('idempotent-replayed'), 'true')
    assert.ok(state.dbCalls > 0 && state.contentCalls > 0)
  })

  it('serves the scheduled mode only with scheduled-review on as well, and keeps Mistakes the default', async () => {
    state.flagsOn = new Set(BOTH)
    const off = await start({mode: 'scheduled'})
    assert.equal(off.status, 404)
    assert.deepEqual([state.dbCalls, state.contentCalls], [0, 0])
    assert.equal((await start({mode: 'spaced'})).status, 400)

    state.flagsOn = new Set([...BOTH, 'scheduled-review'])
    const on = await start({mode: 'scheduled'})
    assert.equal(on.status, 200)
    assert.deepEqual(await on.json(), {status: 'none', mode: 'scheduled', reason: 'nothing_due', nextDueAt: null, unavailableDue: 0})
    assert.deepEqual(await (await start()).json(), {status: 'none', reason: 'no_recent_mistakes'})
    assert.deepEqual(await (await start({mode: 'mistakes'})).json(), {status: 'none', reason: 'no_recent_mistakes'})
  })

  it('updates a review card from /api/attempts only while scheduled-review is on', async () => {
    const cards = async () => (await db.sql<{n: number}[]>`select count(*)::int as n from learner.review_card`)[0].n
    const grade = async (familyId: string) => {
      const issued = await issueTask({db: db.sql, content: state.content!, learnerId: ALICE, assessmentId: `assessment-${familyId}-v1`, now: new Date()})
      const taskInstanceId = issued.status === 'issued' ? issued.body.taskInstanceId : assert.fail()
      const response = await post(attemptsRoute, '/api/attempts', {taskInstanceId, optionId: 'opt-a', idempotencyKey: randomUUID()})
      assert.equal(response.status, 201)
      return attemptResultSchema.parse(await response.json())
    }

    state.flagsOn = new Set(BOTH)
    assert.equal('schedule' in (await grade('fam1')), false)
    assert.equal(await cards(), 0)

    state.flagsOn = new Set([...BOTH, 'scheduled-review'])
    assert.equal((await grade('fam2')).schedule?.status, 'scheduled')
    assert.equal(await cards(), 1)
  })
})
