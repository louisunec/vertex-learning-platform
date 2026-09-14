import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {after, before, beforeEach, describe, it} from 'node:test'
import {promisify} from 'node:util'

import {createTestDatabase, SKIP_WITHOUT_DATABASE, type TestDatabase} from '../db/test-db.ts'
import {claimCandidate, finishCandidate, listCandidates, queueRegeneration, type QueueRequest} from './regenerate.ts'
import type {AssessmentSource} from './sanity-store.ts'

/** The regeneration queue (migration 0007) and its execution switch, against a real Postgres. */

const run = promisify(execFile)
const SCRIPT = new URL('../../scripts/signals.mts', import.meta.url).pathname

const request = (familyId: string): QueueRequest => ({
  signalId: `contentSignal-assessment-${familyId}`,
  assessmentId: `assessment-${familyId}-v1`,
  lessonId: 'lesson-hooks',
  familyId,
  version: 1,
})
const source = (familyId: string, spanKey: string): AssessmentSource => ({
  _id: `assessment-${familyId}-v1`,
  familyId,
  version: 1,
  lessonId: 'lesson-hooks',
  spanKey,
})

describe('regeneration queue', {skip: SKIP_WITHOUT_DATABASE}, () => {
  let db: TestDatabase

  before(async () => {
    db = await createTestDatabase()
  })
  after(() => db?.drop())
  beforeEach(async () => {
    await db.sql`truncate editorial.regeneration_candidate, editorial.job_run`
  })

  it('queues at most one candidate per source revision per UTC day', async () => {
    const today = new Date('2026-09-14T09:00:00Z')
    const first = await queueRegeneration(db.sql, request('asm-1a2b3c4d-s0-q0'), source('asm-1a2b3c4d-s0-q0', 'span-a'), {now: today})
    assert.equal(first.status, 'queued')
    // A sibling item from the same source span, the same day: the same candidate.
    const sibling = await queueRegeneration(db.sql, request('asm-1a2b3c4d-s0-q1'), source('asm-1a2b3c4d-s0-q1', 'span-a'), {now: new Date('2026-09-14T23:59:00Z')})
    assert.equal(sibling.status, 'duplicate')
    // Concurrent queueing of the same source: still one row.
    const racing = await Promise.all(
      Array.from({length: 5}, () => queueRegeneration(db.sql, request('asm-1a2b3c4d-s1-q0'), source('asm-1a2b3c4d-s1-q0', 'span-b'), {now: today})),
    )
    assert.equal(racing.filter((result) => result.status === 'queued').length, 1)
    // The next day it may be queued again.
    assert.equal((await queueRegeneration(db.sql, request('asm-1a2b3c4d-s0-q0'), source('asm-1a2b3c4d-s0-q0', 'span-a'), {now: new Date('2026-09-15T00:00:00Z')})).status, 'queued')
    assert.equal((await listCandidates(db.sql)).length, 3)
  })

  it('respects the daily cap and needs a source revision', async () => {
    const now = new Date('2026-09-14T09:00:00Z')
    for (const [index, spanKey] of ['a', 'b', 'c'].entries()) {
      const result = await queueRegeneration(db.sql, request(`asm-1a2b3c4d-s${index}-q0`), source(`asm-1a2b3c4d-s${index}-q0`, spanKey), {now, dailyCap: 2})
      assert.equal(result.status, index < 2 ? 'queued' : 'skipped')
    }
    assert.deepEqual(await queueRegeneration(db.sql, request('asm-1a2b3c4d-s9-q0'), {...source('asm-1a2b3c4d-s9-q0', 'x'), spanKey: null}, {now}), {
      status: 'skipped',
      reason: 'no_source_key',
    })
  })

  it('lets one worker claim a candidate, and another recover it after the lease expires', async () => {
    await queueRegeneration(db.sql, request('asm-1a2b3c4d-s0-q0'), source('asm-1a2b3c4d-s0-q0', 'span-a'), {now: new Date()})
    const claims = await Promise.all([claimCandidate(db.sql, 'worker-a'), claimCandidate(db.sql, 'worker-b')])
    assert.equal(claims.filter(Boolean).length, 1)
    assert.equal(await claimCandidate(db.sql, 'worker-c'), null)

    await db.sql`update editorial.regeneration_candidate set claimed_until = now() - interval '1 second'`
    const recovered = await claimCandidate(db.sql, 'worker-c')
    assert.equal(recovered?.attempts, 2)
    await finishCandidate(db.sql, 'worker-c', recovered!.id, {status: 'drafted', result: {draftIds: ['drafts.assessment-asm-1a2b3c4d-s0-q0-v2']}})
    const [row] = await listCandidates(db.sql)
    assert.deepEqual([row.status, row.result], ['drafted', {draftIds: ['drafts.assessment-asm-1a2b3c4d-s0-q0-v2']}])
  })

  it('does not execute unless SIGNALS_REGENERATION_ENABLED=true', async () => {
    const env = {PATH: process.env.PATH ?? '', NODE_ENV: 'test' as const, DATABASE_URL: db.url}
    const listed = await run(process.execPath, [SCRIPT, 'regenerate'], {env})
    assert.match(listed.stdout, /Execution is off by default/)
    await assert.rejects(run(process.execPath, [SCRIPT, 'regenerate', '--execute'], {env}), (error: {code?: number; stderr?: string}) => {
      assert.equal(error.code, 1)
      assert.match(error.stderr ?? '', /Regeneration is disabled/)
      return true
    })
  })
})
