import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {after, before, beforeEach, describe, it} from 'node:test'

import {createTestDatabase, SKIP_WITHOUT_DATABASE, type TestDatabase} from '../db/test-db.ts'
import {submitAttempt, type SubmitAttemptOutcome} from './attempts.ts'
import {recordHelpEvent} from './help-events.ts'
import {issueTask, TASK_INSTANCE_TTL_MS} from './task-instances.ts'
import {FixtureContent} from './test-content.ts'

/**
 * Attempts, evidence projection, and help events against a real Postgres
 * (development plan §5 PR-4 acceptance). Content comes from fixtures shaped
 * like the parsed Sanity rows (`test-content.ts`).
 */

const ALICE = 'user_alice'
const BOB = 'user_bob'
const NOW = new Date('2026-09-13T10:00:00.000Z')

const key = () => `key-${randomUUID().replaceAll('-', '')}`

describe('learner evidence', {skip: SKIP_WITHOUT_DATABASE}, () => {
  let db: TestDatabase
  let content: FixtureContent

  before(async () => {
    db = await createTestDatabase()
  })
  after(() => db?.drop())

  beforeEach(async () => {
    await db.sql`truncate learner.event_outbox, learner.concept_mastery, learner.help_event, learner.attempt_log, learner.task_instance, learner.explanation_log`
    content = new FixtureContent()
    content.concepts.set('concept-cpt-state', {id: 'concept-cpt-state', conceptId: 'cpt-state', reviewStatus: 'approved'})
  })

  async function issue(learnerId: string, assessmentId: string, now = NOW): Promise<string> {
    const outcome = await issueTask({db: db.sql, content, learnerId, assessmentId, now})
    assert.equal(outcome.status, 'issued')
    return outcome.status === 'issued' ? outcome.body.taskInstanceId : ''
  }

  function submit(
    learnerId: string,
    taskInstanceId: string,
    {optionId = 'opt-a', idempotencyKey = key(), selfConfidence, now = NOW}: {optionId?: string; idempotencyKey?: string; selfConfidence?: number; now?: Date} = {},
  ): Promise<SubmitAttemptOutcome> {
    return submitAttempt({db: db.sql, content, learnerId, request: {taskInstanceId, optionId, idempotencyKey, selfConfidence}, now})
  }

  const counts = async () => {
    const [row] = await db.sql<{attempts: number; outbox: number; mastery: number}[]>`
      select
        (select count(*)::int from learner.attempt_log) as attempts,
        (select count(*)::int from learner.event_outbox) as outbox,
        (select count(*)::int from learner.concept_mastery) as mastery
    `
    return row
  }

  const mastery = async (learnerId = ALICE, conceptId = 'cpt-state') => {
    const [row] = await db.sql<Record<string, unknown>[]>`
      select independent_correct, independent_incorrect, assisted_correct, assisted_incorrect, estimate, evidence_status, policy_version
      from learner.concept_mastery where learner_id = ${learnerId} and concept_id = ${conceptId}
    `
    return row ?? null
  }

  const graded = (outcome: SubmitAttemptOutcome) => {
    assert.equal(outcome.status, 'graded', JSON.stringify(outcome))
    return outcome.status === 'graded' ? outcome : assert.fail()
  }

  describe('issuing', () => {
    it('stores the delivered version and option ids and returns only the learner-safe item', async () => {
      const id = content.addItem('fam1')
      const outcome = await issueTask({db: db.sql, content, learnerId: ALICE, assessmentId: id, now: NOW})
      assert.equal(outcome.status, 'issued')
      if (outcome.status !== 'issued') return
      assert.equal(outcome.body.expiresAt, new Date(NOW.getTime() + TASK_INSTANCE_TTL_MS).toISOString())
      for (const leak of ['correctOptionId', 'answerKey', 'hints', 'primaryConcept']) {
        assert.ok(!JSON.stringify(outcome.body).includes(leak), leak)
      }
      const [row] = await db.sql`select learner_id, family_id, assessment_version, delivered_option_ids from learner.task_instance`
      assert.deepEqual({...row}, {learner_id: ALICE, family_id: 'fam1', assessment_version: 1, delivered_option_ids: ['opt-a', 'opt-b', 'opt-c']})
    })

    it('issues nothing for unavailable content', async () => {
      assert.deepEqual(await issueTask({db: db.sql, content, learnerId: ALICE, assessmentId: 'assessment-missing-v1', now: NOW}), {
        status: 'not_found',
      })
      assert.equal((await db.sql`select 1 from learner.task_instance`).length, 0)
    })
  })

  describe('grading', () => {
    it('grades a first unaided response as independent evidence, in one commit', async () => {
      const instance = await issue(ALICE, content.addItem('fam1'))
      const outcome = graded(await submit(ALICE, instance, {selfConfidence: 4}))
      assert.equal(outcome.replayed, false)
      assert.deepEqual({...outcome.body, attemptId: 'x'}, {
        attemptId: 'x',
        taskInstanceId: instance,
        correct: true,
        evidence: {kind: 'independent', reasonCode: 'first_independent_response'},
      })
      assert.deepEqual(await mastery(), {
        independent_correct: 1,
        independent_incorrect: 0,
        assisted_correct: 0,
        assisted_incorrect: 0,
        estimate: '0.6667',
        evidence_status: 'independent',
        policy_version: 'evidence-v1',
      })
      const [attempt] = await db.sql`
        select selected_option_id, hint_level_used, answer_exposed, self_confidence, confidence_signal, concept_resolution, resolved_concept_id
        from learner.attempt_log
      `
      assert.deepEqual({...attempt}, {
        selected_option_id: 'opt-a',
        hint_level_used: 0,
        answer_exposed: false,
        self_confidence: 4,
        confidence_signal: 'pre_feedback_1to5_v1',
        concept_resolution: 'active',
        resolved_concept_id: 'cpt-state',
      })
      const outbox = await db.sql<{event_type: string; payload: Record<string, unknown>}[]>`select event_type, payload from learner.event_outbox`
      assert.equal(outbox.length, 1)
      assert.equal(outbox[0].event_type, 'attempt_graded')
      assert.deepEqual(Object.keys(outbox[0].payload).toSorted(), [
        'assessmentId',
        'assessmentVersion',
        'attemptId',
        'conceptId',
        'correct',
        'evidenceKind',
        'evidenceReason',
        'familyId',
        'learnerId',
        'policyVersion',
      ])
    })

    it('grades a wrong answer by option id and never reveals the correct one', async () => {
      const instance = await issue(ALICE, content.addItem('fam1'))
      const outcome = graded(await submit(ALICE, instance, {optionId: 'opt-b'}))
      assert.equal(outcome.body.correct, false)
      assert.ok(!JSON.stringify(outcome.body).includes('opt-a'))
      assert.equal((await mastery())?.estimate, '0.3333')
    })

    it('grades by stable option id even if the options were reordered after delivery', async () => {
      const id = content.addItem('fam1')
      const instance = await issue(ALICE, id)
      const item = content.grading.get(id)!
      content.grading.set(id, {...item, optionIds: [...item.optionIds].reverse()})
      assert.equal(graded(await submit(ALICE, instance)).body.correct, true)
    })

    it("treats another learner's task instance as not found and writes nothing", async () => {
      const instance = await issue(ALICE, content.addItem('fam1'))
      assert.deepEqual(await submit(BOB, instance), {status: 'rejected', code: 'not_found'})
      assert.deepEqual(await counts(), {attempts: 0, outbox: 0, mastery: 0})
    })

    it('rejects expired instances and options that were not delivered', async () => {
      const instance = await issue(ALICE, content.addItem('fam1'))
      const late = new Date(NOW.getTime() + TASK_INSTANCE_TTL_MS)
      assert.deepEqual(await submit(ALICE, instance, {now: late}), {status: 'rejected', code: 'expired'})
      assert.deepEqual(await submit(ALICE, instance, {optionId: 'opt-z'}), {status: 'rejected', code: 'invalid_option'})
      assert.deepEqual(await counts(), {attempts: 0, outbox: 0, mastery: 0})
    })

    it('does not grade content that became unavailable or changed after delivery', async () => {
      const stale = content.addItem('fam1')
      const staleInstance = await issue(ALICE, stale)
      content.grading.delete(stale)
      assert.deepEqual(await submit(ALICE, staleInstance), {status: 'rejected', code: 'task_unavailable'})

      const changed = content.addItem('fam2')
      const changedInstance = await issue(ALICE, changed)
      content.grading.set(changed, {...content.grading.get(changed)!, optionIds: ['opt-a', 'opt-b', 'opt-d']})
      assert.deepEqual(await submit(ALICE, changedInstance), {status: 'rejected', code: 'task_unavailable'})
      assert.deepEqual(await counts(), {attempts: 0, outbox: 0, mastery: 0})
    })
  })

  describe('idempotency', () => {
    it('replays a retried key with the same body without adding evidence', async () => {
      const instance = await issue(ALICE, content.addItem('fam1'))
      const idempotencyKey = key()
      const first = graded(await submit(ALICE, instance, {idempotencyKey}))
      const again = graded(await submit(ALICE, instance, {idempotencyKey}))
      assert.equal(again.replayed, true)
      assert.deepEqual(again.body, first.body)
      assert.deepEqual(await counts(), {attempts: 1, outbox: 1, mastery: 1})
      assert.equal((await mastery())?.independent_correct, 1)
    })

    it('rejects a changed body under the same key, and a second key for the same instance', async () => {
      const instance = await issue(ALICE, content.addItem('fam1'))
      const idempotencyKey = key()
      graded(await submit(ALICE, instance, {idempotencyKey}))
      assert.deepEqual(await submit(ALICE, instance, {idempotencyKey, optionId: 'opt-b'}), {
        status: 'rejected',
        code: 'idempotency_key_reused',
      })
      assert.deepEqual(await submit(ALICE, instance, {idempotencyKey, selfConfidence: 2}), {
        status: 'rejected',
        code: 'idempotency_key_reused',
      })
      assert.deepEqual(await submit(ALICE, instance), {status: 'rejected', code: 'already_submitted'})
      assert.deepEqual(await counts(), {attempts: 1, outbox: 1, mastery: 1})
    })

    it('records concurrent duplicate requests exactly once', async () => {
      const instance = await issue(ALICE, content.addItem('fam1'))
      const idempotencyKey = key()
      const results = await Promise.all(Array.from({length: 6}, () => submit(ALICE, instance, {idempotencyKey})))
      const bodies = results.map((result) => graded(result).body)
      assert.ok(bodies.every((body) => JSON.stringify(body) === JSON.stringify(bodies[0])))
      assert.equal(results.filter((result) => result.status === 'graded' && !result.replayed).length, 1)
      assert.deepEqual(await counts(), {attempts: 1, outbox: 1, mastery: 1})
      assert.equal((await mastery())?.independent_correct, 1)
    })

    it('accepts one of several concurrent submissions for an instance under different keys', async () => {
      const instance = await issue(ALICE, content.addItem('fam1'))
      const results = await Promise.all(Array.from({length: 4}, () => submit(ALICE, instance)))
      assert.equal(results.filter((result) => result.status === 'graded').length, 1)
      assert.equal(results.filter((result) => result.status === 'rejected' && result.code === 'already_submitted').length, 3)
      assert.deepEqual(await counts(), {attempts: 1, outbox: 1, mastery: 1})
    })

    it('counts only one of two concurrent first responses to the same family as independent', async () => {
      const id = content.addItem('fam1')
      const [first, second] = [await issue(ALICE, id), await issue(ALICE, id)]
      const results = await Promise.all([submit(ALICE, first), submit(ALICE, second)])
      const kinds = results.map((result) => graded(result).body.evidence.kind).toSorted()
      assert.deepEqual(kinds, ['independent', 'not_counted'])
      assert.equal((await mastery())?.independent_correct, 1)
    })
  })

  describe('transaction', () => {
    it('rolls back the attempt and projection when a later write fails, and a retry then succeeds once', async () => {
      const instance = await issue(ALICE, content.addItem('fam1'))
      await db.sql.unsafe(`
        create function learner.fail_outbox() returns trigger language plpgsql as $$
        begin raise exception 'injected outbox failure'; end $$;
        create trigger fail_outbox before insert on learner.event_outbox for each row execute function learner.fail_outbox();
      `).simple()
      const idempotencyKey = key()
      try {
        await assert.rejects(submit(ALICE, instance, {idempotencyKey}), /injected outbox failure/)
        assert.deepEqual(await counts(), {attempts: 0, outbox: 0, mastery: 0})
      } finally {
        await db.sql.unsafe('drop trigger fail_outbox on learner.event_outbox; drop function learner.fail_outbox();').simple()
      }
      graded(await submit(ALICE, instance, {idempotencyKey}))
      assert.deepEqual(await counts(), {attempts: 1, outbox: 1, mastery: 1})
    })
  })

  describe('help and exposure', () => {
    const help = (learnerId: string, taskInstanceId: string, level: number, requestKey = key()) =>
      recordHelpEvent(db.sql, learnerId, {requestKey, taskInstanceId, level, policyVersion: 'test-policy', reasonCode: 'test'})

    it('derives assisted evidence from recorded hints, not the client', async () => {
      const instance = await issue(ALICE, content.addItem('fam1'))
      await help(ALICE, instance, 1)
      const outcome = graded(await submit(ALICE, instance))
      assert.deepEqual(outcome.body.evidence, {kind: 'assisted', reasonCode: 'hint_used'})
      const row = await mastery()
      assert.equal(row?.assisted_correct, 1)
      assert.equal(row?.estimate, null)
      assert.equal(row?.evidence_status, 'assisted_only')
    })

    it('records answer exposure after the solution was shown', async () => {
      const instance = await issue(ALICE, content.addItem('fam1'))
      await help(ALICE, instance, 3)
      assert.deepEqual(graded(await submit(ALICE, instance)).body.evidence, {kind: 'assisted', reasonCode: 'answer_exposed'})
      const [row] = await db.sql`select hint_level_used, answer_exposed from learner.attempt_log`
      assert.deepEqual({...row}, {hint_level_used: 3, answer_exposed: true})
    })

    it('counts help received on an earlier instance of the same family', async () => {
      const id = content.addItem('fam1')
      await help(ALICE, await issue(ALICE, id), 2)
      const fresh = await issue(ALICE, id)
      assert.deepEqual(graded(await submit(ALICE, fresh)).body.evidence, {kind: 'assisted', reasonCode: 'hint_used'})
    })

    it("refuses help on another learner's instance, and a retried help request never escalates", async () => {
      const instance = await issue(ALICE, content.addItem('fam1'))
      assert.deepEqual(await help(BOB, instance, 1), {status: 'not_found'})
      const requestKey = key()
      const first = await help(ALICE, instance, 1, requestKey)
      const retry = await help(ALICE, instance, 3, requestKey)
      assert.equal(first.status === 'recorded' && first.replayed, false)
      assert.deepEqual(retry, {status: 'recorded', id: first.status === 'recorded' ? first.id : '', level: 1, replayed: true})
      assert.equal(graded(await submit(ALICE, instance)).body.evidence.reasonCode, 'hint_used')
    })

    it('cannot manufacture independent mastery by repeating a task or answering after exposure', async () => {
      const repeated = content.addItem('fam1')
      for (let round = 0; round < 5; round++) graded(await submit(ALICE, await issue(ALICE, repeated)))
      const kinds = await db.sql<{evidence_kind: string}[]>`select evidence_kind from learner.attempt_log order by created_at`
      assert.deepEqual(kinds.map((row) => row.evidence_kind), ['independent', 'not_counted', 'not_counted', 'not_counted', 'not_counted'])
      assert.equal((await mastery())?.independent_correct, 1)

      const exposed = content.addItem('fam2')
      const first = await issue(ALICE, exposed)
      await help(ALICE, first, 3)
      graded(await submit(ALICE, first))
      for (let round = 0; round < 4; round++) graded(await submit(ALICE, await issue(ALICE, exposed)))
      const row = await mastery()
      assert.equal(row?.independent_correct, 1)
      assert.equal(row?.assisted_correct, 1)
      assert.equal(row?.estimate, '0.6667')
    })
  })

  describe('concept resolution', () => {
    it('follows a merge to the successor concept', async () => {
      content.concepts.set('concept-cpt-old', {id: 'concept-cpt-old', conceptId: 'cpt-old', reviewStatus: 'merged', mergedInto: 'concept-cpt-state'})
      graded(await submit(ALICE, await issue(ALICE, content.addItem('fam1', {concept: 'concept-cpt-old'}))))
      assert.equal((await mastery(ALICE, 'cpt-state'))?.independent_correct, 1)
      assert.equal(await mastery(ALICE, 'cpt-old'), null)
    })

    it('records the attempt without a projection for split, unapproved, and missing concepts', async () => {
      content.concepts.set('concept-cpt-a', {id: 'concept-cpt-a', conceptId: 'cpt-a', reviewStatus: 'approved'})
      content.concepts.set('concept-cpt-b', {id: 'concept-cpt-b', conceptId: 'cpt-b', reviewStatus: 'approved'})
      content.concepts.set('concept-cpt-split', {
        id: 'concept-cpt-split',
        conceptId: 'cpt-split',
        reviewStatus: 'split',
        splitInto: ['concept-cpt-a', 'concept-cpt-b'],
      })
      content.concepts.set('concept-cpt-draft', {id: 'concept-cpt-draft', conceptId: 'cpt-draft', reviewStatus: 'needs_review'})

      const cases = [
        ['fam-split', 'concept-cpt-split', 'split'],
        ['fam-draft', 'concept-cpt-draft', 'unavailable'],
        ['fam-gone', 'concept-cpt-gone', 'unavailable'],
        ['fam-none', null, 'none'],
      ] as const
      for (const [family, concept, resolution] of cases) {
        graded(await submit(ALICE, await issue(ALICE, content.addItem(family, {concept}))))
        const [row] = await db.sql`select concept_resolution, resolved_concept_id from learner.attempt_log where family_id = ${family}`
        assert.deepEqual({...row}, {concept_resolution: resolution, resolved_concept_id: null}, family)
      }
      assert.deepEqual(await counts(), {attempts: 4, outbox: 4, mastery: 0})
    })
  })
})
