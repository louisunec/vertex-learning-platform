import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {after, before, beforeEach, describe, it} from 'node:test'

import type {HelpMode, HelpRequestKind} from '../ai/help-policy.ts'
import {createTestDatabase, SKIP_WITHOUT_DATABASE, type TestDatabase} from '../db/test-db.ts'
import {submitAttempt, type SubmitAttemptOutcome} from './attempts.ts'
import {requestHelp, type RequestHelpOutcome} from './help.ts'
import {issueTask, TASK_INSTANCE_TTL_MS} from './task-instances.ts'
import {FixtureContent, HINTS} from './test-content.ts'

/**
 * The help policy's service against a real Postgres, under the app role
 * (development plan §5 PR-5 acceptance): ladder progression per task
 * instance, retries, concurrency, unavailable material, and how recorded
 * help reaches grading.
 */

const ALICE = 'user_alice'
const BOB = 'user_bob'
const NOW = new Date('2026-09-13T10:00:00.000Z')

const key = () => `key-${randomUUID().replaceAll('-', '')}`

describe('help policy service', {skip: SKIP_WITHOUT_DATABASE}, () => {
  let db: TestDatabase
  let content: FixtureContent

  before(async () => {
    db = await createTestDatabase()
  })
  after(() => db?.drop())

  beforeEach(async () => {
    await db.sql`truncate learner.review_log, learner.review_card, learner.review_session_item, learner.review_session, learner.tutor_request, learner.event_outbox, learner.concept_mastery, learner.help_event, learner.attempt_log, learner.task_instance, learner.explanation_log`
    content = new FixtureContent()
    content.concepts.set('concept-cpt-state', {id: 'concept-cpt-state', conceptId: 'cpt-state', reviewStatus: 'approved'})
  })

  async function issue(learnerId: string, assessmentId: string, now = NOW): Promise<string> {
    const outcome = await issueTask({db: db.sql, content, learnerId, assessmentId, now})
    assert.equal(outcome.status, 'issued')
    return outcome.status === 'issued' ? outcome.body.taskInstanceId : ''
  }

  function ask(
    learnerId: string,
    taskInstanceId: string,
    {request = 'hint', mode = 'study', requestKey = key()}: {request?: HelpRequestKind; mode?: HelpMode; requestKey?: string} = {},
  ): Promise<RequestHelpOutcome> {
    return requestHelp({db: db.sql, content, learnerId, request: {taskInstanceId, mode, request, requestKey}})
  }

  const helped = (outcome: RequestHelpOutcome) => {
    assert.equal(outcome.status, 'helped', JSON.stringify(outcome))
    return outcome.status === 'helped' ? outcome : assert.fail()
  }

  const submit = (learnerId: string, taskInstanceId: string, now = NOW): Promise<SubmitAttemptOutcome> =>
    submitAttempt({db: db.sql, content, learnerId, request: {taskInstanceId, optionId: 'opt-a', idempotencyKey: key()}, now})

  const evidenceOf = (outcome: SubmitAttemptOutcome) => {
    assert.equal(outcome.status, 'graded', JSON.stringify(outcome))
    return outcome.status === 'graded' ? outcome.body.evidence : assert.fail()
  }

  /** A correct answer (`opt-a`) given after the solution: assisted, never independent mastery evidence. */
  const assertExposedCorrect = async (outcome: SubmitAttemptOutcome) => {
    assert.equal(outcome.status === 'graded' && outcome.body.correct, true, JSON.stringify(outcome))
    assert.deepEqual(evidenceOf(outcome), {kind: 'assisted', reasonCode: 'answer_exposed'})
    const [row] = await db.sql`
      select independent_correct, independent_incorrect, assisted_correct, estimate, evidence_status
      from learner.concept_mastery where learner_id = ${ALICE} and concept_id = 'cpt-state'
    `
    assert.deepEqual({...row}, {
      independent_correct: 0,
      independent_incorrect: 0,
      assisted_correct: 1,
      estimate: null,
      evidence_status: 'assisted_only',
    })
  }

  const counts = async () => {
    const [row] = await db.sql<{events: number; outbox: number}[]>`
      select
        (select count(*)::int from learner.help_event) as events,
        (select count(*)::int from learner.event_outbox where event_type = 'help_level_decided') as outbox
    `
    return row
  }

  /** The decided rung only: no other rung's text, and the correct option id with the solution alone. */
  function assertOnlyRung(body: unknown, level: 1 | 2 | 3) {
    const raw = JSON.stringify(body)
    const rungs = [HINTS.direction, HINTS.keyConcept, HINTS.solution]
    rungs.forEach((text, index) => assert.equal(raw.includes(text), index + 1 === level, `level ${level} vs rung ${index + 1}`))
    assert.equal(raw.includes('correctOptionId'), level === 3)
    for (const leak of ['correctReason', 'distractorReasons', 'answerKey']) assert.ok(!raw.includes(leak), leak)
  }

  describe('ladder', () => {
    it('climbs one explicit step at a time and returns only the decided rung', async () => {
      const instance = await issue(ALICE, content.addItem('fam1'))
      const steps = [
        ['hint', 1, 'first_help', HINTS.direction],
        ['escalate', 2, 'escalation', HINTS.keyConcept],
        ['escalate', 3, 'escalation', HINTS.solution],
        ['escalate', 3, 'already_at_solution', HINTS.solution],
      ] as const
      for (const [request, level, reasonCode, text] of steps) {
        const {body, replayed} = helped(await ask(ALICE, instance, {request}))
        assert.equal(replayed, false)
        assert.deepEqual({...body, helpEventId: 'x'}, {
          helpEventId: 'x',
          level,
          reasonCode,
          policyVersion: 'help-v1',
          hint: level === 3 ? {level, text, correctOptionId: 'opt-a'} : {level, text},
          replayed: false,
        })
        assertOnlyRung(body, level)
      }
      const rows = await db.sql`
        select level, reason_code, explicit_override, policy_version, family_id, task_instance_id
        from learner.help_event order by created_at
      `
      assert.deepEqual(
        rows.map((row) => ({...row})),
        steps.map(([, level, reasonCode]) => ({
          level,
          reason_code: reasonCode,
          explicit_override: false,
          policy_version: 'help-v1',
          family_id: 'fam1',
          task_instance_id: instance,
        })),
      )
    })

    it('re-shows the current rung for a repeated hint request instead of escalating', async () => {
      const instance = await issue(ALICE, content.addItem('fam1'))
      helped(await ask(ALICE, instance))
      const again = helped(await ask(ALICE, instance))
      assert.deepEqual([again.body.level, again.body.reasonCode, again.body.hint.text], [1, 'repeat_current', HINTS.direction])
    })

    it('gives the solution at once in reference mode or on request, recorded as an explicit override', async () => {
      const reference = await issue(ALICE, content.addItem('fam1'))
      const byMode = helped(await ask(ALICE, reference, {mode: 'reference'}))
      assert.deepEqual([byMode.body.level, byMode.body.reasonCode], [3, 'reference_mode'])
      assertOnlyRung(byMode.body, 3)

      const study = await issue(ALICE, content.addItem('fam2'))
      helped(await ask(ALICE, study))
      const byRequest = helped(await ask(ALICE, study, {request: 'solution'}))
      assert.deepEqual([byRequest.body.level, byRequest.body.reasonCode], [3, 'explicit_solution'])

      const overrides = await db.sql`select reason_code, explicit_override from learner.help_event where level = 3 order by created_at`
      assert.deepEqual(overrides.map((row) => ({...row})), [
        {reason_code: 'reference_mode', explicit_override: true},
        {reason_code: 'explicit_solution', explicit_override: true},
      ])
    })
  })

  describe('authorization', () => {
    it("treats another learner's task instance as not found and records nothing", async () => {
      const instance = await issue(ALICE, content.addItem('fam1'))
      assert.deepEqual(await ask(BOB, instance), {status: 'rejected', code: 'not_found'})
      assert.deepEqual(await ask(ALICE, randomUUID()), {status: 'rejected', code: 'not_found'})
      assert.deepEqual(await counts(), {events: 0, outbox: 0})
    })
  })

  describe('retries', () => {
    it('replays a request key with its original level, even after a newer escalation', async () => {
      const instance = await issue(ALICE, content.addItem('fam1'))
      const requestKey = key()
      const first = helped(await ask(ALICE, instance, {requestKey}))
      helped(await ask(ALICE, instance, {request: 'escalate'}))
      const retry = helped(await ask(ALICE, instance, {requestKey, request: 'solution'}))
      assert.equal(retry.replayed, true)
      assert.deepEqual(retry.body, {...first.body, replayed: true})
      assertOnlyRung(retry.body, 1)
      assert.deepEqual(await counts(), {events: 2, outbox: 2})
    })

    it('refuses a request key first used for another task instance', async () => {
      const id = content.addItem('fam1')
      const requestKey = key()
      helped(await ask(ALICE, await issue(ALICE, id), {requestKey}))
      assert.deepEqual(await ask(ALICE, await issue(ALICE, id), {requestKey}), {status: 'rejected', code: 'idempotency_key_reused'})
      assert.deepEqual(await counts(), {events: 1, outbox: 1})
    })

    it('records concurrent duplicates of one request exactly once', async () => {
      const instance = await issue(ALICE, content.addItem('fam1'))
      const requestKey = key()
      const results = (await Promise.all(Array.from({length: 6}, () => ask(ALICE, instance, {requestKey, request: 'escalate'})))).map(helped)
      assert.ok(results.every((result) => result.body.helpEventId === results[0].body.helpEventId && result.body.level === 1))
      assert.equal(results.filter((result) => !result.replayed).length, 1)
      assert.deepEqual(await counts(), {events: 1, outbox: 1})
    })

    it('serializes concurrent escalations under different keys to distinct levels', async () => {
      const instance = await issue(ALICE, content.addItem('fam1'))
      helped(await ask(ALICE, instance))
      const results = await Promise.all([ask(ALICE, instance, {request: 'escalate'}), ask(ALICE, instance, {request: 'escalate'})])
      assert.deepEqual(results.map((result) => helped(result).body.level).toSorted(), [2, 3])
    })
  })

  describe('task change', () => {
    it('restarts the ladder on a new instance while the family stays assisted for grading', async () => {
      const id = content.addItem('fam1')
      const first = await issue(ALICE, id)
      helped(await ask(ALICE, first, {request: 'solution'}))

      const second = await issue(ALICE, id)
      const fresh = helped(await ask(ALICE, second))
      assert.deepEqual([fresh.body.level, fresh.body.reasonCode], [1, 'first_help'])
      await assertExposedCorrect(await submit(ALICE, second))
    })
  })

  describe('unavailable material', () => {
    it('refuses help from stale, withdrawn, re-versioned, or changed items and records nothing', async () => {
      const withdrawn = content.addItem('gone')
      const withdrawnInstance = await issue(ALICE, withdrawn)
      content.hints.delete(withdrawn)

      const versioned = content.addItem('versioned')
      const versionedInstance = await issue(ALICE, versioned)
      content.hints.set(versioned, {...content.hints.get(versioned)!, version: 2})

      const changed = content.addItem('changed')
      const changedInstance = await issue(ALICE, changed)
      content.hints.set(changed, {...content.hints.get(changed)!, optionIds: ['opt-a', 'opt-b', 'opt-d']})

      for (const instance of [withdrawnInstance, versionedInstance, changedInstance]) {
        for (const request of ['hint', 'solution'] as const) {
          assert.deepEqual(await ask(ALICE, instance, {request}), {status: 'rejected', code: 'hint_unavailable'})
        }
      }
      assert.deepEqual(await counts(), {events: 0, outbox: 0})
    })

    it('does not replay help once its material is withdrawn', async () => {
      const id = content.addItem('fam1')
      const instance = await issue(ALICE, id)
      const requestKey = key()
      helped(await ask(ALICE, instance, {requestKey}))
      content.hints.delete(id)
      assert.deepEqual(await ask(ALICE, instance, {requestKey}), {status: 'rejected', code: 'hint_unavailable'})
      assert.deepEqual(await counts(), {events: 1, outbox: 1})
    })
  })

  describe('grading', () => {
    it('never counts a correct answer after a revealed solution as independent mastery evidence', async () => {
      const reference = await issue(ALICE, content.addItem('fam1'))
      helped(await ask(ALICE, reference, {mode: 'reference'}))
      await assertExposedCorrect(await submit(ALICE, reference))

      await db.sql`truncate learner.concept_mastery`
      const study = await issue(ALICE, content.addItem('fam2'))
      for (const request of ['hint', 'escalate', 'escalate'] as const) helped(await ask(ALICE, study, {request}))
      await assertExposedCorrect(await submit(ALICE, study))
    })

    it('allows help after answering or expiry without changing the stored grade', async () => {
      const answered = await issue(ALICE, content.addItem('fam1'))
      assert.deepEqual(evidenceOf(await submit(ALICE, answered)), {kind: 'independent', reasonCode: 'first_independent_response'})
      assert.equal(helped(await ask(ALICE, answered, {request: 'solution'})).body.hint.text, HINTS.solution)
      const [attempt] = await db.sql`select evidence_kind, evidence_reason, hint_level_used, answer_exposed from learner.attempt_log`
      assert.deepEqual({...attempt}, {
        evidence_kind: 'independent',
        evidence_reason: 'first_independent_response',
        hint_level_used: 0,
        answer_exposed: false,
      })
      const [row] = await db.sql`select independent_correct, assisted_correct from learner.concept_mastery`
      assert.deepEqual({...row}, {independent_correct: 1, assisted_correct: 0})

      const expired = await issue(ALICE, content.addItem('fam2'), new Date(Date.now() - 2 * TASK_INSTANCE_TTL_MS))
      assert.equal(helped(await ask(ALICE, expired)).body.level, 1)
    })
  })

  describe('outbox', () => {
    it('writes a minimized help_level_decided event with no hint text', async () => {
      const instance = await issue(ALICE, content.addItem('fam1'))
      const {body} = helped(await ask(ALICE, instance, {request: 'solution'}))
      const outbox = await db.sql<{payload: Record<string, unknown>}[]>`
        select payload from learner.event_outbox where event_type = 'help_level_decided'
      `
      assert.equal(outbox.length, 1)
      assert.deepEqual(outbox[0].payload, {
        helpEventId: body.helpEventId,
        learnerId: ALICE,
        taskInstanceId: instance,
        familyId: 'fam1',
        level: 3,
        reasonCode: 'explicit_solution',
        explicitOverride: true,
        policyVersion: 'help-v1',
      })
      const raw = JSON.stringify(outbox[0].payload)
      for (const text of Object.values(HINTS)) assert.ok(!raw.includes(text))
      assert.ok(!raw.includes('opt-a'))
    })
  })
})
