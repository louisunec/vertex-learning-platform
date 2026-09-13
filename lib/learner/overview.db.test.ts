import assert from 'node:assert/strict'
import {after, before, describe, it} from 'node:test'

import {createTestDatabase, SKIP_WITHOUT_DATABASE, type TestDatabase} from '../db/test-db.ts'
import {readLearnerOverview, RECENT_ATTEMPT_LIMIT} from './overview.ts'

/**
 * The My Learning evidence read under the web app's identity: another
 * learner's attempts and mastery never appear, the attempt feed is bounded
 * and newest first, and only independent evidence is counted.
 */

const ALICE = 'user_alice'
const BOB = 'user_bob'

describe('readLearnerOverview', {skip: SKIP_WITHOUT_DATABASE}, () => {
  let db: TestDatabase
  let sequence = 0

  /** Seeds one graded attempt as the superuser (which bypasses RLS). */
  async function seedAttempt(learnerId: string, lessonId: string, reason: string, createdAt: string) {
    sequence += 1
    const [instance] = await db.sql<{id: string}[]>`
      insert into learner.task_instance
        (learner_id, assessment_id, family_id, assessment_version, lesson_id, delivered_option_ids, expires_at)
      values (${learnerId}, ${`assessment-f${sequence}-v1`}, ${`f${sequence}`}, 1, ${lessonId},
              ${db.sql.array(['opt-a', 'opt-b', 'opt-c'])}, now() + interval '1 day')
      returning id
    `
    const kind = reason === 'first_independent_response' ? 'independent' : reason === 'repeat_task' ? 'not_counted' : 'assisted'
    await db.sql`
      insert into learner.attempt_log
        (learner_id, task_instance_id, assessment_id, family_id, assessment_version, selected_option_id, correct,
         hint_level_used, answer_exposed, evidence_kind, evidence_reason, concept_resolution, policy_version,
         idempotency_key, request_hash, created_at)
      values (${learnerId}, ${instance.id}, ${`assessment-f${sequence}-v1`}, ${`f${sequence}`}, 1, 'opt-a', true,
              0, false, ${kind}, ${reason}, 'none', 'evidence-v1',
              ${`key-${learnerId}-${String(sequence).padStart(10, '0')}`}, 'hash', ${createdAt})
    `
  }

  async function seedMastery(learnerId: string, conceptId: string, status: string) {
    await db.sql`
      insert into learner.concept_mastery (learner_id, concept_id, independent_correct, evidence_status, policy_version)
      values (${learnerId}, ${conceptId}, ${status === 'independent' ? 1 : 0}, ${status}, 'evidence-v1')
    `
  }

  before(async () => {
    db = await createTestDatabase()
    await seedAttempt(ALICE, 'lesson-1', 'first_independent_response', '2026-09-10T00:00:00Z')
    await seedAttempt(ALICE, 'lesson-2', 'hint_used', '2026-09-12T00:00:00Z')
    await seedAttempt(ALICE, 'lesson-3', 'repeat_task', '2026-09-11T00:00:00Z')
    await seedAttempt(ALICE, 'lesson-4', 'answer_exposed', '2026-09-09T00:00:00Z')
    await seedAttempt(BOB, 'lesson-bob', 'first_independent_response', '2026-09-13T00:00:00Z')
    await seedMastery(ALICE, 'cpt-loss', 'independent')
    await seedMastery(ALICE, 'cpt-grad', 'assisted_only')
    await seedMastery(BOB, 'cpt-bob', 'independent')
  })
  after(() => db?.drop())

  it("returns the learner's own latest attempts, newest first and bounded", async () => {
    const overview = await readLearnerOverview(db.sql, ALICE)
    assert.equal(overview.recentAttempts.length, RECENT_ATTEMPT_LIMIT)
    assert.deepEqual(
      overview.recentAttempts.map((attempt) => [attempt.lessonId, attempt.evidenceReason]),
      [
        ['lesson-2', 'hint_used'],
        ['lesson-3', 'repeat_task'],
        ['lesson-1', 'first_independent_response'],
      ],
    )
    assert.ok(overview.recentAttempts[0].createdAt instanceof Date)
  })

  it('lists only independently evidenced concepts, never another learner’s', async () => {
    assert.deepEqual((await readLearnerOverview(db.sql, ALICE)).independentConceptIds, ['cpt-loss'])
    const bob = await readLearnerOverview(db.sql, BOB)
    assert.deepEqual(bob.independentConceptIds, ['cpt-bob'])
    assert.deepEqual(bob.recentAttempts.map((attempt) => attempt.lessonId), ['lesson-bob'])
  })

  it('is empty for a learner with no evidence', async () => {
    assert.deepEqual(await readLearnerOverview(db.sql, 'user_new'), {recentAttempts: [], independentConceptIds: []})
  })
})
