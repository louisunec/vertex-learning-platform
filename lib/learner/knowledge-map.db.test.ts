import assert from 'node:assert/strict'
import {after, before, describe, it} from 'node:test'

import {createTestDatabase, SKIP_WITHOUT_DATABASE, type TestDatabase} from '../db/test-db.ts'
import {CONCEPT_ATTEMPT_LIMIT, readConceptAttempts, readMapEvidence} from './knowledge-map.ts'

/**
 * The knowledge map's evidence reads under the web app's identity: another
 * learner's mastery and attempts never appear, the latest independent
 * response per concept is the newest one, and the attempt list is bounded
 * and newest first.
 */

const ALICE = 'user_alice'
const BOB = 'user_bob'

describe('knowledge map evidence', {skip: SKIP_WITHOUT_DATABASE}, () => {
  let db: TestDatabase
  let sequence = 0

  /** Seeds one graded attempt as the superuser (which bypasses RLS). */
  async function seedAttempt(
    learnerId: string,
    conceptId: string | null,
    kind: 'independent' | 'assisted' | 'not_counted',
    correct: boolean,
    createdAt: string,
  ) {
    sequence += 1
    const [instance] = await db.sql<{id: string}[]>`
      insert into learner.task_instance
        (learner_id, assessment_id, family_id, assessment_version, lesson_id, delivered_option_ids, expires_at)
      values (${learnerId}, ${`assessment-f${sequence}-v1`}, ${`f${sequence}`}, 1, 'lesson-1',
              ${db.sql.array(['opt-a', 'opt-b', 'opt-c'])}, now() + interval '1 day')
      returning id
    `
    const reason = kind === 'independent' ? 'first_independent_response' : kind === 'assisted' ? 'hint_used' : 'repeat_task'
    await db.sql`
      insert into learner.attempt_log
        (learner_id, task_instance_id, assessment_id, family_id, assessment_version, selected_option_id, correct,
         hint_level_used, answer_exposed, evidence_kind, evidence_reason, resolved_concept_id, concept_resolution,
         policy_version, idempotency_key, request_hash, created_at)
      values (${learnerId}, ${instance.id}, ${`assessment-f${sequence}-v1`}, ${`f${sequence}`}, 1, 'opt-b', ${correct},
              ${kind === 'assisted' ? 1 : 0}, false, ${kind}, ${reason}, ${conceptId}, ${conceptId ? 'active' : 'none'},
              'evidence-v1', ${`key-${learnerId}-${String(sequence).padStart(10, '0')}`}, 'hash', ${createdAt})
    `
  }

  before(async () => {
    db = await createTestDatabase()
    await seedAttempt(ALICE, 'cpt-loss', 'independent', true, '2026-09-01T00:00:00Z')
    await seedAttempt(ALICE, 'cpt-loss', 'independent', false, '2026-09-11T00:00:00Z')
    await seedAttempt(ALICE, 'cpt-loss', 'assisted', true, '2026-09-12T00:00:00Z')
    await seedAttempt(ALICE, 'cpt-grad', 'assisted', true, '2026-09-10T00:00:00Z')
    await seedAttempt(ALICE, null, 'independent', true, '2026-09-13T00:00:00Z')
    for (let day = 1; day <= CONCEPT_ATTEMPT_LIMIT + 2; day++) {
      await seedAttempt(ALICE, 'cpt-many', 'not_counted', true, `2026-08-${String(day).padStart(2, '0')}T00:00:00Z`)
    }
    await seedAttempt(BOB, 'cpt-loss', 'independent', true, '2026-09-13T00:00:00Z')
    await db.sql`
      insert into learner.concept_mastery
        (learner_id, concept_id, independent_correct, independent_incorrect, assisted_correct, evidence_status, policy_version)
      values (${ALICE}, 'cpt-loss', 1, 1, 1, 'independent', 'evidence-v1'),
             (${ALICE}, 'cpt-grad', 0, 0, 1, 'assisted_only', 'evidence-v1'),
             (${BOB}, 'cpt-bob', 3, 0, 0, 'independent', 'evidence-v1')
    `
  })
  after(() => db?.drop())

  it("reads the learner's own mastery counts only", async () => {
    const {mastery} = await readMapEvidence(db.sql, ALICE)
    assert.deepEqual(mastery, [
      {conceptId: 'cpt-grad', independentCorrect: 0, independentIncorrect: 0, assistedCorrect: 1, assistedIncorrect: 0},
      {conceptId: 'cpt-loss', independentCorrect: 1, independentIncorrect: 1, assistedCorrect: 1, assistedIncorrect: 0},
    ])
    assert.deepEqual((await readMapEvidence(db.sql, BOB)).mastery.map((row) => row.conceptId), ['cpt-bob'])
  })

  it('keeps only the newest independent response per concept, ignoring assisted, repeat, and unlinked ones', async () => {
    const {latestIndependent} = await readMapEvidence(db.sql, ALICE)
    assert.deepEqual(
      latestIndependent.map((row) => [row.conceptId, row.correct, row.createdAt.toISOString()]),
      [['cpt-loss', false, '2026-09-11T00:00:00.000Z']],
    )
    const bob = await readMapEvidence(db.sql, BOB)
    assert.deepEqual(bob.latestIndependent.map((row) => [row.conceptId, row.correct]), [['cpt-loss', true]])
  })

  it("lists a concept's attempts newest first, bounded, and never another learner's", async () => {
    const loss = await readConceptAttempts(db.sql, ALICE, ['cpt-loss'])
    assert.deepEqual(
      loss.map((row) => [row.evidenceKind, row.evidenceReason, row.correct]),
      [
        ['assisted', 'hint_used', true],
        ['independent', 'first_independent_response', false],
        ['independent', 'first_independent_response', true],
      ],
    )
    assert.equal(loss[0].assessmentVersion, 1)
    assert.equal(loss[0].selectedOptionId, 'opt-b')

    const many = await readConceptAttempts(db.sql, ALICE, ['cpt-many', 'cpt-grad'])
    assert.equal(many.length, CONCEPT_ATTEMPT_LIMIT)
    assert.equal(many[0].evidenceReason, 'hint_used')

    const bob = await readConceptAttempts(db.sql, BOB, ['cpt-loss', 'cpt-grad', 'cpt-many'])
    assert.equal(bob.length, 1)
    assert.equal(bob[0].correct, true)
    assert.deepEqual(await readConceptAttempts(db.sql, ALICE, []), [])
  })
})
