import assert from 'node:assert/strict'
import {after, before, describe, it} from 'node:test'

import pg from 'pg'

import {createTestDatabase, SKIP_WITHOUT_DATABASE, type TestDatabase} from '../db/test-db.ts'

/**
 * Driver check for the evaluation's node-postgres corrections (development
 * plan §5 PR-12, follow-up 1). The review never runs code; this test runs a
 * few fixed functions offline with the real `pg` driver, against a disposable
 * test database. Each is a correction the review delivered, copied here as
 * static code (never evaluated from text). No learner code runs, and nothing
 * here is used by the app.
 *
 * - `manual-escaping` and `pg-template-literal` in run 3 (`review-v3`) keep
 *   `db.query`/`client.query`, `$1` and `.rows`. They must find the row and
 *   return null for an injection payload.
 * - `manual-escaping` in run 2 (`review-v2`) gave mysql2's `execute` to
 *   node-postgres code. With the real driver it fails: the functional error
 *   the server's gate now guards against.
 *
 * mysql2 is checked by types only, outside the repo (see the review packet):
 * there is no MySQL server in this environment.
 */

type Queryable = Pick<pg.Client, 'query'>

// run 3, manual-escaping, both corrections (identical code), inside the learner's function.
async function manualEscapingRun3(db: Queryable, username: string) {
  const result = await db.query('SELECT * FROM users WHERE username = $1', [username])
  return result.rows[0] ?? null
}

// run 3, pg-template-literal, both corrections; the return line is the learner's own.
async function pgTemplateLiteralRun3(client: Queryable, username: string) {
  const res = await client.query('SELECT * FROM users WHERE username = $1', [username])
  return res.rows[0] ?? null
}

// run 2, manual-escaping, the bound-parameter correction: mysql2's API on a node-postgres client.
async function manualEscapingRun2Incompatible(db: unknown, username: string) {
  const [rows] = await (db as {execute(sql: string, values: unknown[]): Promise<[unknown[]]>}).execute('SELECT * FROM users WHERE username = ?', [username])
  return rows[0] ?? null
}

const INJECTION = "' OR '1'='1"

describe('node-postgres corrections, with the real driver', {skip: SKIP_WITHOUT_DATABASE}, () => {
  let db: TestDatabase
  let client: pg.Client

  before(async () => {
    db = await createTestDatabase({migrate: false})
    client = new pg.Client({connectionString: db.url})
    await client.connect()
    await client.query('create table users (id serial primary key, username text not null unique)')
    await client.query("insert into users (username) values ('alice'), ('bob')")
  })
  after(async () => {
    await client?.end()
    await db?.drop()
  })

  for (const [name, lookup] of [
    ['manual-escaping (run 3)', manualEscapingRun3],
    ['pg-template-literal (run 3)', pgTemplateLiteralRun3],
  ] as const) {
    it(`${name}: finds the user, returns null for no match and for an injection payload`, async () => {
      assert.equal((await lookup(client, 'alice'))?.username, 'alice')
      assert.equal(await lookup(client, 'carol'), null)
      assert.equal(await lookup(client, INJECTION), null)
      assert.equal(await lookup(client, "alice'--"), null)
    })
  }

  it('manual-escaping (run 2): the mysql2 correction fails on a node-postgres client', async () => {
    await assert.rejects(manualEscapingRun2Incompatible(client, 'alice'), TypeError)
  })
})
