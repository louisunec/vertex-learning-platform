import {createHash} from 'node:crypto'
import {readdir, readFile} from 'node:fs/promises'

import type postgres from 'postgres'

/**
 * Forward-only SQL migrations for the learner database (development plan §5
 * PR-4). Files in `db/migrations/` named `NNNN_name.sql` are applied in
 * order, each in its own transaction, and recorded with a checksum in
 * `learner.schema_migrations`. An applied file that later changes is an
 * error: fix forward with a new file instead.
 *
 * Framework-free (no `server-only`, no env reads) so `npm run db:migrate`
 * and the database tests share it. Offline tooling: never called from a
 * request path.
 */

export const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/

/** Serializes concurrent migrators on one database. */
const MIGRATION_LOCK = 'vertex:learner:migrations'

export class MigrationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MigrationError'
  }
}

type Migration = {name: string; checksum: string; text: string}

async function readMigrations(dir: URL): Promise<Migration[]> {
  const names = (await readdir(dir)).filter((name) => MIGRATION_FILE.test(name)).toSorted()
  return Promise.all(
    names.map(async (name) => {
      const text = await readFile(new URL(name, dir), 'utf8')
      return {name, text, checksum: createHash('sha256').update(text).digest('hex')}
    }),
  )
}

/** Applies pending migrations from `dir` and returns the names applied, in order. */
export async function applyMigrations(sql: postgres.Sql, dir: URL): Promise<string[]> {
  const migrations = await readMigrations(dir)
  const applied: string[] = []

  for (const migration of migrations) {
    const ran = await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${MIGRATION_LOCK}, 0))`
      await tx`create schema if not exists learner`
      await tx`
        create table if not exists learner.schema_migrations (
          name text primary key,
          checksum text not null,
          applied_at timestamptz not null default now()
        )
      `
      await tx`alter table learner.schema_migrations enable row level security`
      const [existing] = await tx<{checksum: string}[]>`
        select checksum from learner.schema_migrations where name = ${migration.name}
      `
      if (existing) {
        if (existing.checksum !== migration.checksum) {
          throw new MigrationError(`Migration ${migration.name} changed after it was applied. Add a new migration instead.`)
        }
        return false
      }
      await tx.unsafe(migration.text).simple()
      await tx`insert into learner.schema_migrations (name, checksum) values (${migration.name}, ${migration.checksum})`
      return true
    })
    if (ran) applied.push(migration.name)
  }
  return applied
}
