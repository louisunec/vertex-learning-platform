import assert from 'node:assert/strict'
import {after, before, describe, it} from 'node:test'

import postgres from 'postgres'

import {asLearner, LEARNER_APP_ROLE} from '../db/learner-scope.ts'
import {createTestDatabase, SKIP_WITHOUT_DATABASE, type TestDatabase} from '../db/test-db.ts'

/**
 * Row level security under the identities that actually reach the learner
 * tables (migration 0001), not the superuser the other suites seed with:
 *
 * - the web app: `vertex_learner_app` with `app.learner_id` set to a Clerk
 *   user id, exactly as `asLearner` runs every service query;
 * - Supabase's Data API: `anon` / `authenticated` carrying a learner's JWT
 *   claims, including after a deliberately mistaken grant, so the policies
 *   themselves are shown to hold, not only the missing privileges.
 */

const ALICE = 'user_alice'
const BOB = 'user_bob'
const LEARNER_TABLES = ['task_instance', 'attempt_log', 'help_event', 'concept_mastery', 'tutor_request', 'explanation_log'] as const

/** Postgres `insufficient_privilege`, also raised for a row-level-security violation. */
const denied = (error: unknown) => (error as {code?: string}).code === '42501'

const HASH = 'a'.repeat(64)

/** A pending explanation row that satisfies migration 0008's new-row checks. */
const insertExplanation = (tx: postgres.Sql | postgres.TransactionSql, learnerId: string, requestKey: string) => tx`
  insert into learner.explanation_log
    (learner_id, task_id, task_version, lesson_id, rubric_version, response, evaluation_status, request_key, request_hash,
     cache_key, response_hash, char_count, task_hash, source_refs, concept_ids, prompt_version, validator_version, claim_token, claimed_at)
  values
    (${learnerId}, 'task', '1', 'lesson-hooks', ${HASH}, 'private explanation', 'pending', ${requestKey}, ${HASH},
     ${HASH}, ${HASH}, 19, ${HASH}, '[]'::jsonb, '{}', 'explain-v1', 'explain-gates-v1', gen_random_uuid(), now())
`

describe('row level security', {skip: SKIP_WITHOUT_DATABASE}, () => {
  let db: TestDatabase
  const ids: Record<string, string> = {}

  /** Seeds one full set of rows per learner as the superuser (which bypasses RLS). */
  async function seed(learnerId: string) {
    const [instance] = await db.sql<{id: string}[]>`
      insert into learner.task_instance
        (learner_id, assessment_id, family_id, assessment_version, lesson_id, delivered_option_ids, expires_at)
      values (${learnerId}, 'assessment-fam1-v1', 'fam1', 1, 'lesson-hooks', ${db.sql.array(['opt-a', 'opt-b', 'opt-c'])}, now() + interval '1 day')
      returning id
    `
    ids[learnerId] = instance.id
    await db.sql`
      insert into learner.attempt_log
        (learner_id, task_instance_id, assessment_id, family_id, assessment_version, selected_option_id, correct,
         hint_level_used, answer_exposed, evidence_kind, evidence_reason, concept_resolution, policy_version,
         idempotency_key, request_hash)
      values (${learnerId}, ${instance.id}, 'assessment-fam1-v1', 'fam1', 1, 'opt-a', true,
              0, false, 'independent', 'first_independent_response', 'active', 'evidence-v1',
              ${`key-${learnerId}-0000000000`}, 'hash')
    `
    const [help] = await db.sql<{id: string}[]>`
      insert into learner.help_event (learner_id, task_instance_id, family_id, level, policy_version, reason_code, request_key)
      values (${learnerId}, ${instance.id}, 'fam1', 1, 'p', 'r', ${`help-${learnerId}-000000000`})
      returning id
    `
    await db.sql`
      insert into learner.tutor_request
        (learner_id, request_key, lesson_id, help_event_id, status, scope, evidence_count, cited_count, prompt_version)
      values (${learnerId}, ${`help-${learnerId}-000000000`}, 'lesson-hooks', ${help.id}, 'supported', 'window', 3, 1, 'tutor-v1')
    `
    await db.sql`
      insert into learner.concept_mastery (learner_id, concept_id, independent_correct, estimate, evidence_status, policy_version)
      values (${learnerId}, 'cpt-state', 1, 0.6667, 'independent', 'evidence-v1')
    `
    await db.sql`insert into learner.event_outbox (event_type, payload) values ('attempt_graded', ${db.sql.json({learnerId})})`
    await insertExplanation(db.sql, learnerId, `explain-${learnerId}-00000`)
  }

  before(async () => {
    db = await createTestDatabase()
    await seed(ALICE)
    await seed(BOB)
  })
  after(() => db?.drop())

  /** Runs `run` as the app role with no learner identity, then rolls back. */
  const withoutIdentity = (run: (tx: postgres.TransactionSql) => Promise<void>, learnerId?: string) =>
    db.sql.begin(async (tx) => {
      await tx`set local role vertex_learner_app`
      if (learnerId !== undefined) await tx`select set_config('app.learner_id', ${learnerId}, true)`
      await run(tx)
    })

  describe('as the web app (vertex_learner_app with a learner id)', () => {
    it('runs service queries under the app role and learner identity', async () => {
      const [row] = await asLearner(db.sql, ALICE, (tx) => tx<{role: string; learner: string}[]>`
        select current_user as role, current_setting('app.learner_id') as learner
      `)
      assert.deepEqual({...row}, {role: LEARNER_APP_ROLE, learner: ALICE})
    })

    it('uses a role that cannot bypass RLS and owns no learner table', async () => {
      const [role] = await db.sql<{rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean}[]>`
        select rolsuper, rolbypassrls, rolcanlogin from pg_roles where rolname = ${LEARNER_APP_ROLE}
      `
      assert.deepEqual({...role}, {rolsuper: false, rolbypassrls: false, rolcanlogin: false})
      const owners = await db.sql<{tableowner: string}[]>`select distinct tableowner from pg_tables where schemaname = 'learner'`
      assert.ok(owners.every((row) => row.tableowner !== LEARNER_APP_ROLE))
    })

    it("sees only the learner's own rows, even without a learner filter", async () => {
      for (const table of LEARNER_TABLES) {
        const rows = await asLearner(db.sql, ALICE, (tx) => tx<{learner_id: string}[]>`select learner_id from ${tx(`learner.${table}`)}`)
        assert.deepEqual(rows.map((row) => row.learner_id), [ALICE], table)
      }
      const bobs = await asLearner(db.sql, ALICE, (tx) => tx`select id from learner.task_instance where id = ${ids[BOB]}`)
      assert.equal(bobs.length, 0)
    })

    it('cannot write rows for another learner', async () => {
      const attempts: Record<string, (tx: postgres.TransactionSql) => Promise<unknown>> = {
        task_instance: (tx) => tx`
          insert into learner.task_instance
            (learner_id, assessment_id, family_id, assessment_version, lesson_id, delivered_option_ids, expires_at)
          values (${BOB}, 'a', 'f', 1, 'l', ${tx.array(['a', 'b', 'c'])}, now())
        `,
        attempt_log: (tx) => tx`
          insert into learner.attempt_log
            (learner_id, task_instance_id, assessment_id, family_id, assessment_version, selected_option_id, correct,
             hint_level_used, answer_exposed, evidence_kind, evidence_reason, concept_resolution, policy_version,
             idempotency_key, request_hash)
          values (${BOB}, ${ids[ALICE]}, 'a', 'f', 1, 'opt-a', true, 0, false, 'independent', 'first_independent_response',
                  'none', 'evidence-v1', 'key-forged-00000000000', 'hash')
        `,
        help_event: (tx) => tx`
          insert into learner.help_event (learner_id, level, policy_version, reason_code, request_key)
          values (${BOB}, 3, 'p', 'r', 'help-forged-0000000000')
        `,
        concept_mastery: (tx) => tx`
          insert into learner.concept_mastery (learner_id, concept_id, evidence_status, policy_version)
          values (${BOB}, 'cpt-other', 'unknown', 'evidence-v1')
        `,
        event_outbox: (tx) => tx`insert into learner.event_outbox (event_type, payload) values ('x', ${tx.json({learnerId: BOB})})`,
        tutor_request: (tx) => tx`
          insert into learner.tutor_request (learner_id, request_key, lesson_id, status, scope, evidence_count, cited_count, prompt_version)
          values (${BOB}, 'tutor-forged-000000000', 'lesson-hooks', 'insufficient_evidence', 'course', 0, 0, 'tutor-v1')
        `,
        explanation_log: (tx) => insertExplanation(tx, BOB, 'explain-forged-000000'),
      }
      for (const [table, write] of Object.entries(attempts)) {
        await assert.rejects(asLearner(db.sql, ALICE, write), denied, table)
      }
    })

    it("cannot complete, re-point, or reassign another learner's explanation", async () => {
      const touched = await asLearner(db.sql, ALICE, (tx) => tx`
        update learner.explanation_log set evaluation_status = 'failed' where learner_id = ${BOB} returning 1
      `)
      assert.equal(touched.length, 0)
      await assert.rejects(
        asLearner(db.sql, ALICE, (tx) => tx`update learner.explanation_log set response = 'rewritten' where learner_id = ${ALICE}`),
        denied,
        'the submitted text is never updatable',
      )
      const [bob] = await db.sql`select evaluation_status, response from learner.explanation_log where learner_id = ${BOB}`
      assert.deepEqual([bob.evaluation_status, bob.response], ['pending', 'private explanation'])
    })

    it("cannot change another learner's mastery or move a row to another learner", async () => {
      const updated = await asLearner(db.sql, ALICE, (tx) => tx`
        update learner.concept_mastery set independent_correct = 99 where learner_id = ${BOB} returning 1
      `)
      assert.equal(updated.length, 0)
      await assert.rejects(
        asLearner(db.sql, ALICE, (tx) => tx`update learner.concept_mastery set learner_id = ${BOB} where learner_id = ${ALICE}`),
        denied,
      )
      const [bob] = await db.sql`select independent_correct from learner.concept_mastery where learner_id = ${BOB}`
      assert.equal(bob.independent_correct, 1)
    })

    it('cannot delete anything, including its own rows', async () => {
      for (const table of [...LEARNER_TABLES, 'event_outbox']) {
        await assert.rejects(asLearner(db.sql, ALICE, (tx) => tx`delete from ${tx(`learner.${table}`)}`), denied, table)
      }
    })

    it('can write its own outbox events but never read the outbox or migrations', async () => {
      await asLearner(db.sql, ALICE, (tx) => tx`insert into learner.event_outbox (event_type, payload) values ('x', ${tx.json({learnerId: ALICE})})`)
      for (const table of ['event_outbox', 'schema_migrations']) {
        await assert.rejects(asLearner(db.sql, ALICE, (tx) => tx`select 1 from ${tx(`learner.${table}`)}`), denied, table)
      }
    })

    it('sees and writes nothing without a learner identity, or with an empty one', async () => {
      for (const learnerId of [undefined, '']) {
        await withoutIdentity(async (tx) => {
          for (const table of LEARNER_TABLES) {
            assert.equal((await tx`select 1 from ${tx(`learner.${table}`)}`).length, 0, `${table} ${learnerId}`)
          }
        }, learnerId)
        await assert.rejects(
          withoutIdentity(
            (tx) => tx`insert into learner.help_event (learner_id, level, policy_version, reason_code, request_key)
                       values (${ALICE}, 0, 'p', 'r', 'help-noidentity-00000')`.then(() => {}),
            learnerId,
          ),
          denied,
        )
      }
    })

    it('leaves neither the role nor the learner identity on a reused connection', async () => {
      // One physical connection, so every statement below reuses the same session, as a pooler would.
      const connection = postgres(db.url, {max: 1, prepare: false, onnotice: () => {}})
      try {
        await asLearner(connection, ALICE, (tx) => tx`select 1`)
        const [after] = await connection<{pid: number; role: string; learner: string | null}[]>`
          select pg_backend_pid() as pid, current_user as role, nullif(current_setting('app.learner_id', true), '') as learner
        `
        assert.deepEqual({role: after.role, learner: after.learner}, {role: 'postgres', learner: null})
        const [pid, leaked] = await connection.begin(async (tx) => {
          await tx`set local role vertex_learner_app`
          return [await tx<{pid: number}[]>`select pg_backend_pid() as pid`, await tx`select 1 from learner.attempt_log`]
        })
        assert.equal(pid[0].pid, after.pid)
        assert.equal(leaked.length, 0)
      } finally {
        await connection.end()
      }
    })
  })

  describe("as Supabase's Data API roles with a learner's JWT claims", () => {
    const asApiRole = (role: 'anon' | 'authenticated', run: (tx: postgres.TransactionSql) => Promise<unknown>) =>
      db.sql.begin(async (tx) => {
        await tx`select set_config('role', ${role}, true)`
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({sub: ALICE, role})}, true)`
        return run(tx)
      })

    it('cannot reach the learner schema at all', async () => {
      for (const role of ['anon', 'authenticated'] as const) {
        for (const table of [...LEARNER_TABLES, 'event_outbox']) {
          await assert.rejects(asApiRole(role, (tx) => tx`select 1 from ${tx(`learner.${table}`)}`), denied, `${role} ${table}`)
        }
      }
    })

    it('still reads and writes nothing if the tables were granted by mistake', async () => {
      await db.sql.unsafe(`
        grant usage on schema learner to anon, authenticated;
        grant select, insert, update, delete on all tables in schema learner to anon, authenticated;
      `).simple()
      try {
        for (const role of ['anon', 'authenticated'] as const) {
          for (const table of [...LEARNER_TABLES, 'event_outbox']) {
            const rows = await asApiRole(role, (tx) => tx`select 1 from ${tx(`learner.${table}`)}`)
            assert.equal((rows as unknown[]).length, 0, `${role} ${table}`)
          }
          await assert.rejects(
            asApiRole(role, (tx) => tx`
              insert into learner.help_event (learner_id, level, policy_version, reason_code, request_key)
              values (${ALICE}, 3, 'p', 'r', 'help-api-00000000000')
            `),
            denied,
            role,
          )
        }
      } finally {
        await db.sql.unsafe(`
          revoke all on all tables in schema learner from anon, authenticated;
          revoke all on schema learner from anon, authenticated;
        `).simple()
      }
    })
  })
})
