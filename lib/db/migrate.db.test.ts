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
  'synthetic_learner',
  'schema_migrations',
]
const EDITORIAL_TABLES = ['job_run', 'regeneration_candidate']
const MIGRATIONS = ['0001_learner_evidence.sql', '0002_tutor_requests.sql', '0007_editorial_signals.sql']

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

  it('creates the editorial job tables with row level security', async () => {
    const rows = await db.sql<{name: string; rls: boolean}[]>`
      select c.relname as name, c.relrowsecurity as rls
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'editorial' and c.relkind = 'r'
    `
    assert.deepEqual(rows.map((row) => row.name).toSorted(), [...EDITORIAL_TABLES].toSorted())
    for (const row of rows) assert.equal(row.rls, true, row.name)
  })

  it('gives the Data API roles no access', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const schemaName of ['learner', 'editorial']) {
        const [schema] = await db.sql<{usage: boolean}[]>`select has_schema_privilege(${role}, ${schemaName}, 'usage') as usage`
        assert.equal(schema.usage, false, `${role} ${schemaName}`)
      }
      for (const table of [...TABLES.map((name) => `learner.${name}`), ...EDITORIAL_TABLES.map((name) => `editorial.${name}`)]) {
        const [privilege] = await db.sql<{read: boolean}[]>`
          select has_table_privilege(${role}, ${table}, 'select') as read
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
      synthetic_learner: [],
      explanation_log: [],
      schema_migrations: [],
    }
    for (const [name, allowed] of Object.entries(granted)) {
      for (const privilege of ['select', 'insert', 'update', 'delete', 'truncate']) {
        assert.equal(await table(name, privilege), allowed.includes(privilege), `${name} ${privilege}`)
      }
    }
    const column = async (name: string) => {
      const [row] = await db.sql<{ok: boolean}[]>`
        select has_column_privilege('vertex_learner_app', 'learner.concept_mastery', ${name}, 'update') as ok
      `
      return row.ok
    }
    assert.equal(await column('independent_correct'), true)
    assert.equal(await column('estimate'), true)
    assert.equal(await column('learner_id'), false)
    assert.equal(await column('concept_id'), false)
    const [editorial] = await db.sql<{usage: boolean}[]>`select has_schema_privilege('vertex_learner_app', 'editorial', 'usage') as usage`
    assert.equal(editorial.usage, false)
  })

  it('gives the worker role only what the dispatcher and signal jobs use', async () => {
    const table = async (name: string, privilege: string) => {
      const [row] = await db.sql<{ok: boolean}[]>`
        select has_table_privilege('vertex_signals_worker', ${name}, ${privilege}) as ok
      `
      return row.ok
    }
    const granted: Record<string, string[]> = {
      'learner.task_instance': [],
      'learner.attempt_log': ['select'],
      'learner.help_event': [],
      'learner.concept_mastery': [],
      'learner.explanation_log': [],
      'learner.tutor_request': ['select'],
      'learner.synthetic_learner': ['select', 'insert'],
      'learner.event_outbox': ['select'],
      'learner.schema_migrations': [],
      'editorial.job_run': ['select', 'insert', 'update'],
      'editorial.regeneration_candidate': ['select', 'insert', 'update'],
    }
    for (const [name, allowed] of Object.entries(granted)) {
      for (const privilege of ['select', 'insert', 'update', 'delete', 'truncate']) {
        assert.equal(await table(name, privilege), allowed.includes(privilege), `${name} ${privilege}`)
      }
    }
    const outboxColumn = async (name: string) => {
      const [row] = await db.sql<{ok: boolean}[]>`
        select has_column_privilege('vertex_signals_worker', 'learner.event_outbox', ${name}, 'update') as ok
      `
      return row.ok
    }
    for (const name of ['status', 'attempts', 'next_attempt_at', 'last_error', 'claimed_by', 'claimed_until', 'delivered_at']) {
      assert.equal(await outboxColumn(name), true, name)
    }
    for (const name of ['payload', 'event_type', 'created_at', 'id']) assert.equal(await outboxColumn(name), false, name)
    const [role] = await db.sql<{super: boolean; bypass: boolean; login: boolean}[]>`
      select rolsuper as super, rolbypassrls as bypass, rolcanlogin as login from pg_roles where rolname = 'vertex_signals_worker'
    `
    assert.deepEqual(role, {super: false, bypass: false, login: false})
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
