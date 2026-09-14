import assert from 'node:assert/strict'
import {register} from 'node:module'
import {before, beforeEach, describe, it} from 'node:test'

import {progressDocumentId} from './save.ts'

/**
 * The real `app/api/progress/route.ts` handler, unchanged, with only its
 * external edges replaced: Clerk's `auth()`, the Sanity-backed progress
 * store (an in-memory store with the same create-once-then-patch
 * semantics), and the write client's error type. Proves that the learner id
 * comes only from the session, that one learner's saves never touch another
 * learner's row, and that invalid input is rejected before any store access.
 *
 * The module hooks only affect this file's test process.
 */

type Row = {userId: string; lessonId: string; resumeSeconds: number; completed: boolean; completedAt: string | null; updatedAt: string}

type RouteState = {
  userId: string | null
  lessons: Map<string, number | null>
  rows: Map<string, Row>
  lessonReads: number
  writes: Array<{documentId: string; userId: string}>
  writerUnavailable: boolean
}

const state: RouteState = {userId: null, lessons: new Map(), rows: new Map(), lessonReads: 0, writes: [], writerUnavailable: false}
Object.assign(globalThis, {__progressRoute: state})

const STUBS: Record<string, string> = {
  '@clerk/nextjs/server': `
    export async function auth() { return {userId: globalThis.__progressRoute.userId} }
  `,
  '@/sanity/lib/learner-client': `
    export class ProgressWriterUnavailableError extends Error {}
  `,
  '@/lib/progress/store': `
    import {ProgressWriterUnavailableError} from '@/sanity/lib/learner-client'
    const s = () => globalThis.__progressRoute
    export const sanityProgressStore = {
      async loadPublishedLesson(lessonId) {
        s().lessonReads++
        return s().lessons.has(lessonId) ? {_id: lessonId, durationSeconds: s().lessons.get(lessonId)} : null
      },
      async write(w) {
        if (s().writerUnavailable) throw new ProgressWriterUnavailableError('no token')
        s().writes.push({documentId: w.documentId, userId: w.userId})
        const row = s().rows.get(w.documentId) ?? {userId: w.userId, lessonId: w.lessonId, resumeSeconds: 0, completed: false, completedAt: null, updatedAt: w.at}
        row.resumeSeconds = w.resumeSeconds
        row.updatedAt = w.at
        if (w.markCompleted) { row.completed = true; row.completedAt ??= w.at }
        s().rows.set(w.documentId, row)
      },
    }
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
const LESSON = 'lesson.ml-gradient-descent'

describe('POST /api/progress', () => {
  let POST: (request: Request) => Promise<Response>

  before(async () => {
    register(`data:text/javascript,${encodeURIComponent(HOOKS)}`)
    ;({POST} = await import('../../app/api/progress/route.ts'))
  })

  beforeEach(() => {
    Object.assign(state, {userId: ALICE, lessons: new Map([[LESSON, 900]]), rows: new Map(), lessonReads: 0, writes: [], writerUnavailable: false})
  })

  const post = (body: unknown) =>
    POST(
      new Request('http://localhost/api/progress', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(body),
      }),
    )

  it('returns 401 without a session, before any store access', async () => {
    state.userId = null
    const response = await post({lessonId: LESSON, positionSeconds: 30})
    assert.equal(response.status, 401)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual([state.lessonReads, state.writes.length], [0, 0])
  })

  it('rejects a body that names a user, so identity can only come from the session', async () => {
    const response = await post({lessonId: LESSON, positionSeconds: 30, userId: BOB})
    assert.equal(response.status, 400)
    assert.deepEqual([state.lessonReads, state.writes.length], [0, 0])
  })

  it('rejects invalid progress input before any store access', async () => {
    for (const body of [
      {lessonId: 'drafts.' + LESSON, positionSeconds: 30},
      {lessonId: LESSON, positionSeconds: -1},
      {lessonId: LESSON, positionSeconds: '30'},
      {lessonId: LESSON},
    ]) {
      assert.equal((await post(body)).status, 400, JSON.stringify(body))
    }
    assert.deepEqual([state.lessonReads, state.writes.length], [0, 0])
  })

  it("saves to the session learner's own row", async () => {
    const response = await post({lessonId: LESSON, positionSeconds: 312.7})
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {status: 'saved', lessonId: LESSON, resumeSeconds: 312, markedCompleted: false})
    assert.deepEqual(state.writes, [{documentId: progressDocumentId(ALICE, LESSON), userId: ALICE}])
  })

  it("never changes another learner's row", async () => {
    await post({lessonId: LESSON, positionSeconds: 600, completed: true})
    const alice = structuredClone(state.rows.get(progressDocumentId(ALICE, LESSON)))

    state.userId = BOB
    await post({lessonId: LESSON, positionSeconds: 12})

    assert.deepEqual(state.rows.get(progressDocumentId(ALICE, LESSON)), alice)
    const bob = state.rows.get(progressDocumentId(BOB, LESSON))
    assert.equal(bob?.userId, BOB)
    assert.equal(bob?.resumeSeconds, 12)
    assert.equal(bob?.completed, false)
    assert.equal(state.rows.size, 2)
  })

  it('returns 404 for a lesson that is not published, without writing', async () => {
    const response = await post({lessonId: 'lesson.unknown', positionSeconds: 5})
    assert.equal(response.status, 404)
    assert.equal(state.writes.length, 0)
  })

  it('returns a retryable 503 when no progress writer is configured', async () => {
    state.writerUnavailable = true
    const response = await post({lessonId: LESSON, positionSeconds: 5})
    assert.equal(response.status, 503)
    assert.equal((await response.json()).retryable, true)
  })
})
