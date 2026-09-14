import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {correctionConflict, establishesDriver, readConventions} from './review-conventions.ts'

// The eval set's drivers (`scripts/review-eval-cases.json`), as learners write them.
const NODE_POSTGRES = [
  'async function findUserByUsername(db, username) {',
  "  const safe = username.replace(/'/g, \"''\")",
  "  const result = await db.query(\"SELECT * FROM users WHERE username = '\" + safe + \"'\")",
  '  return result.rows[0] ?? null',
  '}',
].join('\n')
const MYSQL2 = [
  'async function findUserByUsername(db, username) {',
  "  const [rows] = await db.query(`SELECT * FROM users WHERE username = '${username}'`)",
  '  return rows[0] ?? null',
  '}',
].join('\n')
const BETTER_SQLITE3 = [
  'async function findUserByUsername(db, username) {',
  "  const lookup = db.prepare('SELECT * FROM users WHERE username = ?')",
  '  const user = lookup.get(username)',
  '  return user === undefined ? null : user',
  '}',
].join('\n')
const POSTGRES_JS = [
  'async function findUserByUsername(db, username) {',
  '  const [user] = await db`select * from users where username = ${username}`',
  '  return user ?? null',
  '}',
].join('\n')
const KNEX = ['async function findUserByUsername(db, username) {', "  const user = await db('users').where({ username }).first()", '  return user ?? null', '}'].join('\n')
const HELPER = ["import { runUserQuery } from './queries.js'", '', 'async function findUserByUsername(db, username) {', '  return runUserQuery(db, username)', '}'].join('\n')

describe('readConventions', () => {
  it('reads each driver the pilot task names from the code alone', () => {
    const pg = readConventions(NODE_POSTGRES)
    assert.deepEqual([[...pg.methods], [...pg.results], pg.firstCall], [['query'], ['rows'], 'db.query'])
    const mysql = readConventions(MYSQL2)
    assert.deepEqual([[...mysql.methods], [...mysql.results], mysql.tagged], [['query'], ['destructure'], false], 'a template literal is not a tag')
    const sqlite = readConventions(BETTER_SQLITE3)
    assert.deepEqual([[...sqlite.methods].sort(), [...sqlite.placeholders]], [['get', 'prepare'], ['question']])
    const postgresJs = readConventions(POSTGRES_JS)
    assert.deepEqual([postgresJs.tagged, postgresJs.methods.size], [true, 0])
    const knex = readConventions(KNEX)
    assert.deepEqual([knex.builder, [...knex.methods].sort()], [true, ['first', 'where']])
  })

  it('does not take prose inline code, a closing backtick, or a helper call for a driver', () => {
    assert.equal(readConventions('Pass `username` as a bound value.').tagged, false)
    assert.equal(readConventions("await db.query(`SELECT * FROM users`, [])").tagged, false)
    assert.equal(establishesDriver(readConventions(HELPER)), false)
  })
})

describe('correctionConflict', () => {
  // The two incompatible corrections observed in run 2 (docs/evals/pr-12-review-packet.md), verbatim.
  const MYSQL2_FIX_FOR_NODE_POSTGRES =
    "Pass the username as a bound parameter to the query API. Example (mysql2 style using ? placeholder):\n\nconst [rows] = await db.execute('SELECT * FROM users WHERE username = ?', [username])\nreturn rows[0] ?? null"
  const NODE_POSTGRES_FIX_FOR_MYSQL2 =
    "Call the query with a parameter placeholder and a separate values array. Example (pg-style $1):\nconst res = await db.query('SELECT * FROM users WHERE username = $1', [username])\nreturn res.rows[0] ?? null"

  it('rejects a mysql2 correction on node-postgres code (manual-escaping, run 2)', () => {
    assert.equal(correctionConflict(readConventions(NODE_POSTGRES), MYSQL2_FIX_FOR_NODE_POSTGRES), 'other_method')
  })

  it('rejects a node-postgres correction on mysql2 code (fixed-after-feedback step 1, run 2)', () => {
    assert.equal(correctionConflict(readConventions(MYSQL2), NODE_POSTGRES_FIX_FOR_MYSQL2), 'other_result_access')
  })

  it('keeps a correction in the same driver as the submission', () => {
    const samePg = "const result = await db.query('SELECT * FROM users WHERE username = $1', [username])\nreturn result.rows[0] ?? null"
    assert.equal(correctionConflict(readConventions(NODE_POSTGRES), samePg), null)
    const sameMysql = "const [rows] = await db.query('SELECT * FROM users WHERE username = ?', [username])"
    assert.equal(correctionConflict(readConventions(MYSQL2), sameMysql), null)
    assert.equal(correctionConflict(readConventions(BETTER_SQLITE3), "db.prepare('SELECT * FROM users WHERE username = ?').get(username)"), null)
    assert.equal(correctionConflict(readConventions(POSTGRES_JS), 'const [user] = await db`select * from users where username = ${username}`'), null)
  })

  it('rejects the placeholder style the driver does not take', () => {
    assert.equal(correctionConflict(readConventions(NODE_POSTGRES), "const result = await db.query('SELECT * FROM users WHERE username = ?', [username])"), 'other_placeholder')
    assert.equal(correctionConflict(readConventions(MYSQL2), "const [rows] = await db.query('SELECT * FROM users WHERE username = $1', [username])"), 'other_placeholder')
  })

  it('rejects a correction that shows several drivers', () => {
    const both = "// node-postgres\nconst result = await db.query('... $1', [username])\n// mysql2\nconst [rows] = await db.execute('... ?', [username])"
    assert.equal(correctionConflict(readConventions(NODE_POSTGRES), both), 'other_method')
  })

  it('rejects any executable query when the submission shows no driver, and allows words or a helper-only fix', () => {
    const invented = "const res = await db.query('SELECT * FROM users WHERE username = $1', [username]);\nreturn res.rows[0] || null;"
    assert.equal(correctionConflict(readConventions(HELPER), invented), 'code_without_driver')
    assert.equal(correctionConflict(readConventions(HELPER), 'Share the code of runUserQuery, or name your driver.'), null)
    assert.equal(correctionConflict(readConventions(HELPER), 'const row = await runUserQuery(db, username);\nreturn row || null;'), null)
  })

  it('allows prose with no query code on any submission', () => {
    assert.equal(correctionConflict(readConventions(NODE_POSTGRES), 'Return null explicitly when no row matches.'), null)
  })
})
