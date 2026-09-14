/**
 * Gate 4 of submission review (development plan §5 PR-12): a correction must
 * keep the driver conventions the learner's own code establishes. A
 * correction that switches driver is a functional error, because applied as
 * written it breaks working code. Examples: `db.execute` and `[rows]` given
 * to node-postgres code that calls `db.query` and reads `result.rows`, or
 * `$1` and `res.rows` given to mysql2-style `[rows] = await db.query(...)`.
 *
 * Lexical and deliberately narrow: it compares the data-access calls, the
 * result access, and the placeholder family in the submission with those in
 * the correction text. It is a guard, not proof that a correction works: it
 * cannot run code, and a correction that passes may still be wrong. When in
 * doubt it rejects, and the server's guidance replaces the code. So a valid
 * same-driver switch (mysql2 `query` to `execute`) also loses its snippet.
 * Framework-free.
 */

/** Data-access method names of the pilot task's drivers (node-postgres, mysql2, better-sqlite3, postgres.js, Knex); anything else is ignored. */
const DB_METHODS = ['query', 'execute', 'prepare', 'get', 'raw', 'unsafe', 'first', 'where', 'select'] as const
const METHOD_CALL = new RegExp(`\\.\\s*(${DB_METHODS.join('|')})\\s*\\(`, 'g')
const RECEIVER_CALL = new RegExp(`\\b([A-Za-z_$][\\w$]*)\\s*\\.\\s*(${DB_METHODS.join('|')})\\s*\\(`)
// A tag in expression position (`await db\`…\``, `= sql\`…\``). Not a word before a closing backtick (`FROM users\``), not prose inline code.
const TAGGED = /(?:^|[=(,;:]|\bawait|\breturn)[ \t]*([A-Za-z_][\w$]*)`/gm
const KEYWORDS = new Set(['return', 'await', 'yield', 'typeof', 'case', 'in', 'of', 'new', 'throw', 'void', 'delete', 'else', 'do'])
const BUILDER = /(?<![.\w$])([A-Za-z_$][\w$]*)\(\s*['"`][\w.]+['"`]\s*\)\s*\./g
const ROWS_ACCESS = /\.rows\b/
const DESTRUCTURED_AWAIT = /(?:const|let|var)\s*\[[^\]=]*\]\s*=\s*await\b/
const DOLLAR_PLACEHOLDER = /\$\d+/
const QUESTION_PLACEHOLDER = /['"`][^'"`\n]*\?[^'"`\n]*['"`]/

export type ResultAccess = 'rows' | 'destructure'
export type PlaceholderStyle = 'dollar' | 'question'

export type DriverConventions = {
  /** Data-access methods called anywhere, such as `query` or `prepare`. */
  methods: ReadonlySet<string>
  /** A tagged-template query, such as postgres.js `db\`...\``. */
  tagged: boolean
  /** A query-builder call, such as Knex `db('users').where(...)`. */
  builder: boolean
  results: ReadonlySet<ResultAccess>
  placeholders: ReadonlySet<PlaceholderStyle>
  /** The first data-access call as written, such as `db.query`, for guidance text. */
  firstCall: string | null
}

function hasTag(code: string): boolean {
  for (const match of code.matchAll(TAGGED)) if (!KEYWORDS.has(match[1])) return true
  return false
}

function hasBuilder(code: string): boolean {
  for (const match of code.matchAll(BUILDER)) if (match[1] !== 'require' && match[1] !== 'import') return true
  return false
}

export function readConventions(code: string): DriverConventions {
  const methods = new Set([...code.matchAll(METHOD_CALL)].map((match) => match[1]))
  const results = new Set<ResultAccess>()
  if (ROWS_ACCESS.test(code)) results.add('rows')
  if (DESTRUCTURED_AWAIT.test(code)) results.add('destructure')
  const placeholders = new Set<PlaceholderStyle>()
  if (DOLLAR_PLACEHOLDER.test(code)) placeholders.add('dollar')
  if (QUESTION_PLACEHOLDER.test(code)) placeholders.add('question')
  const receiver = code.match(RECEIVER_CALL)
  return {methods, tagged: hasTag(code), builder: hasBuilder(code), results, placeholders, firstCall: receiver ? `${receiver[1]}.${receiver[2]}` : null}
}

/** Whether the code shows how it talks to the database at all. */
export function establishesDriver(conventions: DriverConventions): boolean {
  return conventions.methods.size > 0 || conventions.tagged || conventions.builder
}

/**
 * The placeholder family the submission's own result handling implies, for
 * the drivers the pilot task names: `.rows` is node-postgres (`$1`), an
 * awaited destructured `query`/`execute` is mysql2 (`?`). Null when the code
 * does not settle it.
 */
function impliedPlaceholder(submission: DriverConventions): PlaceholderStyle | null {
  if (submission.placeholders.size === 1) return [...submission.placeholders][0]
  if (submission.placeholders.size > 1) return null
  const rows = submission.results.has('rows')
  const destructured = submission.results.has('destructure') && (submission.methods.has('query') || submission.methods.has('execute'))
  if (rows && !destructured) return 'dollar'
  if (destructured && !rows) return 'question'
  return null
}

export type ConventionConflict =
  | 'code_without_driver'
  | 'other_method'
  | 'other_query_style'
  | 'other_result_access'
  | 'other_placeholder'

/**
 * Why `correction` breaks the conventions of `submission`, or null when it
 * keeps them (or has no data-access code at all).
 */
export function correctionConflict(submission: DriverConventions, correction: string): ConventionConflict | null {
  const fix = readConventions(correction)
  const fixCalls = establishesDriver(fix)
  if (!establishesDriver(submission)) return fixCalls ? 'code_without_driver' : null
  for (const method of fix.methods) if (!submission.methods.has(method)) return 'other_method'
  if ((fix.tagged && !submission.tagged) || (fix.builder && !submission.builder)) return 'other_query_style'
  if (submission.results.size > 0) {
    for (const access of fix.results) if (!submission.results.has(access)) return 'other_result_access'
  }
  const family = impliedPlaceholder(submission)
  if (family) {
    for (const style of fix.placeholders) if (style !== family) return 'other_placeholder'
  }
  return null
}
