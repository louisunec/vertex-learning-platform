import assert from 'node:assert/strict'
import {cp, mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {after, before, describe, it} from 'node:test'
import {pathToFileURL} from 'node:url'

import {applyMigrations, MigrationError} from './migrate.ts'
import {createTestDatabase, MIGRATIONS_DIR, SKIP_WITHOUT_DATABASE, type TestDatabase} from './test-db.ts'

const TABLES = [
  'task_instance',
  'attempt_log',
  'help_event',
  'concept_mastery',
  'explanation_log',
  'event_outbox',
  'tutor_request',
  'schema_migrations',
]
const MIGRATIONS = ['0001_learner_evidence.sql', '0002_tutor_requests.sql', '0008_explanation_feedback.sql']

describe('learner database migrations', {skip: SKIP_WITHOUT_DATABASE}, () => {
  let db: TestDatabase

  // The harness creates Supabase's Data API roles, so the guarded revoke runs.
  before(async () => {
    db = await createTestDatabase({migrate: false})
  })
  after(() => db?.drop())

  it('applies every migration once, then nothing', async () => {
    assert.deepEqual(await applyMigrations(db.sql, MIGRATIONS_DIR), MIGRATIONS)
    assert.deepEqual(await applyMigrations(db.sql, MIGRATIONS_DIR), [])
  })

  it('creates every table in the learner schema with row level security', async () => {
    const rows = await db.sql<{name: string; rls: boolean}[]>`
      select c.relname as name, c.relrowsecurity as rls
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'learner' and c.relkind = 'r'
    `
    assert.deepEqual(rows.map((row) => row.name).toSorted(), [...TABLES].toSorted())
    for (const row of rows) assert.equal(row.rls, true, row.name)
  })

  it('gives the Data API roles no access', async () => {
    for (const role of ['anon', 'authenticated']) {
      const [schema] = await db.sql<{usage: boolean}[]>`select has_schema_privilege(${role}, 'learner', 'usage') as usage`
      assert.equal(schema.usage, false, role)
      for (const table of TABLES) {
        const [privilege] = await db.sql<{read: boolean}[]>`
          select has_table_privilege(${role}, ${`learner.${table}`}, 'select') as read
        `
        assert.equal(privilege.read, false, `${role} ${table}`)
      }
    }
  })

  it('gives the app role only the privileges its services use', async () => {
    const table = async (name: string, privilege: string) => {
      const [row] = await db.sql<{ok: boolean}[]>`
        select has_table_privilege('vertex_learner_app', ${`learner.${name}`}, ${privilege}) as ok
      `
      return row.ok
    }
    const granted: Record<string, string[]> = {
      task_instance: ['select', 'insert'],
      attempt_log: ['select', 'insert'],
      help_event: ['select', 'insert'],
      concept_mastery: ['select', 'insert'],
      event_outbox: ['insert'],
      tutor_request: ['select', 'insert'],
      explanation_log: ['select', 'insert'],
      schema_migrations: [],
    }
    for (const [name, allowed] of Object.entries(granted)) {
      for (const privilege of ['select', 'insert', 'update', 'delete', 'truncate']) {
        assert.equal(await table(name, privilege), allowed.includes(privilege), `${name} ${privilege}`)
      }
    }
    const column = async (name: string, relation = 'learner.concept_mastery') => {
      const [row] = await db.sql<{ok: boolean}[]>`
        select has_column_privilege('vertex_learner_app', ${relation}, ${name}, 'update') as ok
      `
      return row.ok
    }
    assert.equal(await column('independent_correct'), true)
    assert.equal(await column('estimate'), true)
    assert.equal(await column('learner_id'), false)
    assert.equal(await column('concept_id'), false)
    // An explanation's claim and completion columns change; what was submitted and judged against never does.
    for (const name of ['evaluation_status', 'criterion_findings', 'claim_token', 'completed_at', 'evidence_kind', 'revision_of']) {
      assert.equal(await column(name, 'learner.explanation_log'), true, name)
    }
    for (const name of ['learner_id', 'response', 'task_id', 'task_version', 'rubric_version', 'task_hash', 'request_key', 'request_hash', 'source_refs']) {
      assert.equal(await column(name, 'learner.explanation_log'), false, name)
    }
  })

  it('checks every new explanation row, without re-checking rows written before 0008', async () => {
    const fresh = await createTestDatabase({migrate: false})
    try {
      const dir = await mkdtemp(join(tmpdir(), 'vertex-migrations-'))
      try {
        await cp(MIGRATIONS_DIR, dir, {recursive: true})
        await rm(join(dir, '0008_explanation_feedback.sql'))
        await applyMigrations(fresh.sql, pathToFileURL(`${dir}/`))
      } finally {
        await rm(dir, {recursive: true, force: true})
      }
      // A row in 0001's shape, as a shared database could hold before this migration.
      await fresh.sql`
        insert into learner.explanation_log (learner_id, task_id, task_version, lesson_id, rubric_version, response, evaluation_status)
        values ('user_legacy', 'task', '1', 'lesson', '1', 'legacy text', 'pending')
      `
      assert.deepEqual(await applyMigrations(fresh.sql, MIGRATIONS_DIR), ['0008_explanation_feedback.sql'])
      await assert.rejects(
        fresh.sql`
          insert into learner.explanation_log (learner_id, task_id, task_version, lesson_id, rubric_version, response, evaluation_status)
          values ('user_new', 'task', '1', 'lesson', '1', 'new text in the old shape', 'pending')
        `,
        (error: {code?: string}) => error.code === '23514',
      )
      const [legacy] = await fresh.sql`select count(*)::int as n from learner.explanation_log`
      assert.equal(legacy.n, 1)
    } finally {
      await fresh.drop()
    }
  })

  it('refuses a migration file that changed after it was applied', async () => {
    const copy = await mkdtemp(join(tmpdir(), 'vertex-migrations-'))
    try {
      await cp(MIGRATIONS_DIR, copy, {recursive: true})
      await writeFile(join(copy, '0001_learner_evidence.sql'), '-- edited\n', {flag: 'a'})
      await assert.rejects(applyMigrations(db.sql, pathToFileURL(`${copy}/`)), MigrationError)
    } finally {
      await rm(copy, {recursive: true, force: true})
    }
  })
})

describe('concurrent migrators', {skip: SKIP_WITHOUT_DATABASE}, () => {
  let db: TestDatabase

  before(async () => {
    db = await createTestDatabase({migrate: false})
  })
  after(() => db?.drop())

  it('apply each migration exactly once', async () => {
    const results = await Promise.all([applyMigrations(db.sql, MIGRATIONS_DIR), applyMigrations(db.sql, MIGRATIONS_DIR)])
    assert.deepEqual(results.flat().toSorted(), MIGRATIONS)
  })
})
