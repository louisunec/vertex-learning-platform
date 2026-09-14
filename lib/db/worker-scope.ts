import type postgres from 'postgres'

/**
 * Runs background-worker queries (the outbox dispatcher and the editorial
 * signal jobs, development plan §5 PR-10) as `vertex_signals_worker`
 * (migration 0007): one transaction that switches to a role that cannot
 * bypass row level security, can read the signal sources, update only the
 * outbox's delivery columns, and write the job tables, and can delete
 * nothing. The setting is transaction-local, so it never leaks across
 * pooled connections. Never used in a request path.
 *
 * Framework-free so the CLI scripts and tests share it.
 */

export const SIGNALS_WORKER_ROLE = 'vertex_signals_worker'

/** Bounds every worker statement; aggregation reads whole windows, so it is looser than a request's. */
const STATEMENT_TIMEOUT = '30s'

export type WorkerTx = postgres.TransactionSql

export async function asSignalsWorker<T>(db: postgres.Sql, run: (tx: WorkerTx) => Promise<T>): Promise<T> {
  const result = await db.begin(async (tx) => {
    await tx`set local role vertex_signals_worker`
    await tx`select set_config('statement_timeout', ${STATEMENT_TIMEOUT}, true)`
    return run(tx)
  })
  return result as T
}
