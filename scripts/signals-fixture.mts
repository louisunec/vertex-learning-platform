import postgres from 'postgres'

import {applyMigrations} from '../lib/db/migrate.ts'
import {seedSignalFixture} from '../lib/signals/fixture-seed.ts'

/**
 * Seeds the PR-10 FIXTURE learner records (`lib/signals/fixture-seed.ts`)
 * into an isolated local database, to demonstrate editorial signals without
 * real learner activity. Refuses any database that is not on localhost or
 * whose name does not start with `vertex_fixture`.
 *
 *   FIXTURE_DATABASE_URL=postgres://postgres:…@localhost:54336/vertex_fixture_signals npm run signals:fixture
 *
 * Then, against the same database (DATABASE_URL set to it):
 *   npm run signals -- aggregate --as-of 2026-09-14 --lookback 0 --events docs/editorial-signals/fixture-events.json --dry-run
 */

const raw = process.env.FIXTURE_DATABASE_URL?.trim()
if (!raw) {
  console.error('Set FIXTURE_DATABASE_URL to a local database named vertex_fixture… (it is created if missing).')
  process.exit(1)
}
const url = new URL(raw)
const name = url.pathname.replace(/^\//, '')
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !/^vertex_fixture[a-z0-9_]*$/.test(name)) {
  console.error('Refusing: the fixture database must be on localhost and named vertex_fixture….')
  process.exit(1)
}

const admin = postgres({host: url.hostname, port: Number(url.port || 5432), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: 'postgres', onnotice: () => {}})
const [exists] = await admin`select 1 from pg_database where datname = ${name}`
if (!exists) await admin.unsafe(`create database ${name}`)
await admin.end()

const sql = postgres(raw, {max: 1, prepare: false, onnotice: () => {}})
try {
  await applyMigrations(sql, new URL('../db/migrations/', import.meta.url))
  const [{attempts}] = await sql<{attempts: number}[]>`select count(*)::int as attempts from learner.attempt_log`
  if (attempts > 0) {
    console.log(`${name} already holds ${attempts} attempt(s); not seeding again.`)
  } else {
    await seedSignalFixture(sql)
    console.log(`Seeded the PR-10 fixture into ${name} (FIXTURE records, not real learner activity).`)
  }
} finally {
  await sql.end()
}
