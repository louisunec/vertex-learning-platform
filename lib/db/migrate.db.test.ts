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
  'review_session',
  'review_session_item',
  'review_card',
  'review_log',
  'learning_goal',
  'schema_migrations',
]
const MIGRATIONS = [
  '0001_learner_evidence.sql',
  '0002_tutor_requests.sql',
  '0003_review_sessions.sql',
  '0004_review_cards.sql',
  '0005_learning_goal.sql',
]

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
      review_session: ['select', 'insert'],
      review_session_item: ['select', 'insert'],
      review_card: ['select', 'insert'],
      review_log: ['select', 'insert'],
      learning_goal: ['select', 'insert'],
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
    const goalColumn = async (name: string) => {
      const [row] = await db.sql<{ok: boolean}[]>`
        select has_column_privilege('vertex_learner_app', 'learner.learning_goal', ${name}, 'update') as ok
      `
      return row.ok
    }
    assert.equal(await goalColumn('course_id'), true)
    assert.equal(await goalColumn('learner_id'), false)
  })

  it('lets the app role update only a review card’s scheduler state', async () => {
    const column = async (name: string) => {
      const [row] = await db.sql<{ok: boolean}[]>`
        select has_column_privilege('vertex_learner_app', 'learner.review_card', ${name}, 'update') as ok
      `
      return row.ok
    }
    for (const name of ['due', 'stability', 'difficulty', 'reps', 'lapses', 'state', 'last_review', 'updated_at']) {
      assert.equal(await column(name), true, name)
    }
    for (const name of ['id', 'learner_id', 'concept_id', 'task_type', 'created_at']) assert.equal(await column(name), false, name)
  })

  it('keeps earlier review sessions in Mistakes mode and accepts only scheduled items with a card', async () => {
    const [row] = await db.sql<{mode: string}[]>`
      select column_default as mode from information_schema.columns
      where table_schema = 'learner' and table_name = 'review_session' and column_name = 'mode'
    `
    assert.equal(row.mode, "'mistakes'::text")
    const checks = await db.sql<{name: string}[]>`
      select conname as name from pg_constraint where conrelid = 'learner.review_session_item'::regclass and contype = 'c'
    `
    assert.ok(checks.some((check) => check.name === 'review_session_item_card_check'))
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
