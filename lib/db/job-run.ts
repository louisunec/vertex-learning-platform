import type postgres from 'postgres'

import {asSignalsWorker} from './worker-scope.ts'

/**
 * `editorial.job_run` (migration 0007): one row per background job run,
 * used as its checkpoint and its operational log. Counts hold numbers and
 * short codes only; `error` is a bounded message, never a payload.
 */

export type JobName = 'outbox_dispatch' | 'signal_aggregation' | 'regeneration'

export type JobRunCounts = Record<string, number | string | null | Record<string, number | string | null>>

const MAX_ERROR_LENGTH = 500

export async function startJobRun(
  db: postgres.Sql,
  job: JobName,
  worker: string,
  window: {start: Date; end: Date} | null = null,
): Promise<string> {
  const [row] = await asSignalsWorker(
    db,
    (tx) => tx<{id: string}[]>`
      insert into editorial.job_run (job, worker, window_start, window_end)
      values (${job}, ${worker}, ${window?.start ?? null}, ${window?.end ?? null})
      returning id
    `,
  )
  return row.id
}

export async function finishJobRun(
  db: postgres.Sql,
  id: string,
  outcome: {status: 'succeeded' | 'failed'; counts: JobRunCounts; error?: string | null},
): Promise<void> {
  const error = outcome.error ? outcome.error.slice(0, MAX_ERROR_LENGTH) : null
  await asSignalsWorker(
    db,
    (tx) => tx`
      update editorial.job_run
      set status = ${outcome.status}, counts = ${tx.json(outcome.counts)}, error = ${error}, finished_at = now()
      where id = ${id}
    `,
  )
}

export type JobRunRow = {
  id: string
  job: JobName
  worker: string
  status: string
  windowStart: Date | null
  windowEnd: Date | null
  counts: JobRunCounts
  error: string | null
  startedAt: Date
  finishedAt: Date | null
}

export async function recentJobRuns(db: postgres.Sql, job: JobName, limit = 5): Promise<JobRunRow[]> {
  return asSignalsWorker(
    db,
    (tx) => tx<JobRunRow[]>`
      select id, job, worker, status, window_start as "windowStart", window_end as "windowEnd", counts, error,
        started_at as "startedAt", finished_at as "finishedAt"
      from editorial.job_run where job = ${job}
      order by started_at desc limit ${limit}
    `,
  )
}
