import {randomUUID} from 'node:crypto'

import type postgres from 'postgres'

import {addSyntheticLearner} from './synthetic.ts'

/**
 * FIXTURE learner records for demonstrating editorial signals (development
 * plan §5 PR-10) in an isolated database: never real learner activity.
 * Used by the database tests and by `npm run signals:fixture`, which only
 * writes to a local database whose name starts with `vertex_fixture`.
 *
 * In the window starting 2026-09-07 (7 days, UTC) it produces:
 * - assessment v2 of one family: 25 independent first attempts, 18 wrong
 *   (72%), plus assisted attempts and retries: raises a signal;
 * - v1 of the same family: 30 attempts, 10 wrong: does not;
 * - v3: 20 attempts, all wrong, all by accounts labelled synthetic:
 *   excluded, so no signal;
 * - three tutor questions on `lesson-reading` answered with insufficient
 *   evidence at 3:20: raises a signal.
 * Replay and search events come from docs/editorial-signals/fixture-events.json.
 */

export const FIXTURE_FAMILY = 'asm-1a2b3c4d-s0-q0'
export const FIXTURE_LESSON = 'lesson-hooks'
export const FIXTURE_AT = new Date('2026-09-09T12:00:00Z')

type Kind = 'independent' | 'assisted' | 'not_counted'
const REASON: Record<Kind, string> = {independent: 'first_independent_response', assisted: 'hint_used', not_counted: 'repeat_task'}

export async function insertFixtureAttempt(
  sql: postgres.Sql,
  {learnerId, version, correct, kind = 'independent', at = FIXTURE_AT, familyId = FIXTURE_FAMILY}: {learnerId: string; version: number; correct: boolean; kind?: Kind; at?: Date; familyId?: string},
): Promise<void> {
  const assessmentId = `assessment-${familyId}-v${version}`
  await sql.begin(async (tx) => {
    const [instance] = await tx<{id: string}[]>`
      insert into learner.task_instance (learner_id, assessment_id, family_id, assessment_version, lesson_id, delivered_option_ids, issued_at, expires_at)
      values (${learnerId}, ${assessmentId}, ${familyId}, ${version}, ${FIXTURE_LESSON}, ${tx.array(['opt-a', 'opt-b', 'opt-c'])}, ${at}, ${new Date(at.getTime() + 3_600_000)})
      returning id
    `
    await tx`
      insert into learner.attempt_log
        (learner_id, task_instance_id, assessment_id, family_id, assessment_version, selected_option_id, correct,
         hint_level_used, answer_exposed, evidence_kind, evidence_reason, concept_resolution, policy_version,
         idempotency_key, request_hash, created_at)
      values (${learnerId}, ${instance.id}, ${assessmentId}, ${familyId}, ${version}, 'opt-a', ${correct},
              ${kind === 'assisted' ? 1 : 0}, false, ${kind}, ${REASON[kind]}, 'none', 'evidence-v1',
              ${`key-${randomUUID().replaceAll('-', '')}`}, 'fixture', ${at})
    `
  })
}

/** Seeds the fixture described above. Needs a connection that may write learner tables (the owner, not the app role). */
export async function seedSignalFixture(sql: postgres.Sql): Promise<void> {
  const cohort = async (prefix: string, version: number, count: number, incorrect: number) => {
    for (let index = 0; index < count; index++) {
      await insertFixtureAttempt(sql, {learnerId: `${prefix}_${index}`, version, correct: index >= incorrect})
    }
  }
  await cohort('fixture_v2', 2, 25, 18)
  for (let index = 0; index < 5; index++) await insertFixtureAttempt(sql, {learnerId: `fixture_help_${index}`, version: 2, correct: false, kind: 'assisted'})
  for (let index = 0; index < 4; index++) await insertFixtureAttempt(sql, {learnerId: `fixture_v2_${index}`, version: 2, correct: true, kind: 'not_counted'})
  await cohort('fixture_v1', 1, 30, 10)
  await cohort('fixture_synthetic', 3, 20, 20)
  for (let index = 0; index < 20; index++) {
    await addSyntheticLearner(sql, {learnerId: `fixture_synthetic_${index}`, label: 'test', note: 'PR-10 fixture: excluded from aggregates'})
  }
  for (const learner of ['fixture_tutor_1', 'fixture_tutor_2', 'fixture_tutor_3']) {
    await sql`
      insert into learner.tutor_request (learner_id, request_key, lesson_id, status, scope, evidence_count, cited_count, prompt_version, current_seconds, created_at)
      values (${learner}, ${`key-${randomUUID().replaceAll('-', '')}`}, 'lesson-reading', 'insufficient_evidence', 'course', 0, 0, 'tutor-v5', 200, ${FIXTURE_AT})
    `
  }
}
