import type postgres from 'postgres'

/**
 * Runs learner-evidence queries under the database's own isolation
 * (migration 0001). Each call is one transaction that switches to
 * `vertex_learner_app`, a role that cannot bypass row level security, and
 * sets `app.learner_id` to the Clerk user id, so its statements can only
 * see and write that learner's rows, whatever the SQL says. Both settings
 * are transaction-local, so they never leak across pooled connections.
 *
 * `learnerId` must come from `auth()` on the server. Framework-free so
 * services and tests share it.
 */

export const LEARNER_APP_ROLE = 'vertex_learner_app'

/** Bounds every statement run for a learner request. */
const STATEMENT_TIMEOUT = '5s'

export type LearnerTx = postgres.TransactionSql

export async function asLearner<T>(db: postgres.Sql, learnerId: string, run: (tx: LearnerTx) => Promise<T>): Promise<T> {
  if (!learnerId) throw new Error('A learner id is required')
  const result = await db.begin(async (tx) => {
    await tx`set local role vertex_learner_app`
    await tx`select set_config('app.learner_id', ${learnerId}, true), set_config('statement_timeout', ${STATEMENT_TIMEOUT}, true)`
    return run(tx)
  })
  return result as T
}
