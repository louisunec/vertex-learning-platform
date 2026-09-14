import type postgres from 'postgres'

import {finishJobRun, startJobRun} from '../db/job-run.ts'
import {asSignalsWorker, type WorkerTx} from '../db/worker-scope.ts'
import {SinkError, type Sink, type SinkErrorCategory} from './posthog-sink.ts'
import {outboxLearnerId, PROJECTED_EVENT_TYPES, projectOutboxRow, type CaptureEvent} from './projection.ts'

/**
 * The learner outbox dispatcher (development plan §5 PR-10, completing
 * PR-4's `learner.event_outbox`). Offline: `npm run outbox -- dispatch`.
 *
 * Each batch:
 *
 * 1. **Claim** (one transaction): due `pending` rows of an event type with an
 *    approved projection (`projection.ts`) whose lease is empty or expired,
 *    oldest first, `FOR UPDATE SKIP LOCKED` so concurrent workers
 *    take disjoint rows. The claim sets the lease and increments `attempts`,
 *    so a worker that dies mid-send still used up an attempt and a poison
 *    row cannot loop forever. An expired lease (crashed or stalled worker)
 *    makes the row claimable again: that is the abandoned-claim recovery.
 * 2. **Filter**: rows of labelled synthetic learners become `suppressed`;
 *    rows whose payload fails their projection's schema become `failed`
 *    (`invalid_payload`, visible in `status`, requeueable). Neither is sent.
 *    Rows of an event type with no projection are never claimed: they stay
 *    `pending` with their attempt budget intact, and `status` reports them
 *    as held, so they are sent once a projection is added, never dropped.
 * 3. **Send** the rest in one PostHog batch, outside any transaction.
 * 4. **Record**: accepted → `delivered`, by id while still `pending`,
 *    whoever holds the lease now (PostHog has the event, so that is always
 *    true). Rejected → backoff and `last_error` (a category, never a
 *    payload), or `failed` at the attempt cap; only the lease holder records
 *    a failure, so a stale worker never double-counts. Any sink failure ends
 *    the run: the next run retries after the backoff.
 *
 * Delivery guarantee: at-least-once, with a stable event id. If PostHog
 * accepts a batch and recording `delivered` then fails (crash, database
 * error), the rows keep their lease, and after it expires a later run sends
 * them again with the same `uuid` (the row id) and `timestamp` (the row's
 * `created_at`). PostHog may merge such duplicates, but this code does not
 * rely on it; exact counts should use distinct `uuid`. Exactly-once is not
 * claimed.
 *
 * Grading never waits for any of this: attempts and help commit their
 * outbox rows in their own transactions, and the dispatcher reads and
 * updates only the outbox.
 */

export const DISPATCH_DEFAULTS = {
  batchSize: 50,
  maxBatches: 20,
  leaseSeconds: 120,
  maxAttempts: 8,
  backoffBaseSeconds: 30,
  backoffCapSeconds: 6 * 60 * 60,
} as const

export const MAX_BATCH_SIZE = 200

export type DispatchOptions = {
  db: postgres.Sql
  sink: Sink
  /** Identifies this worker's leases, e.g. `<host>:<pid>:<random>`. */
  workerId: string
  batchSize?: number
  maxBatches?: number
  leaseSeconds?: number
  maxAttempts?: number
  backoffBaseSeconds?: number
  backoffCapSeconds?: number
  /** Record the run in `editorial.job_run` (the CLI does; most tests don't). */
  recordRun?: boolean
}

export type DispatchSummary = {
  batches: number
  claimed: number
  delivered: number
  suppressed: number
  invalid: number
  retried: number
  deadLettered: number
  /** Pending rows at the attempt cap and not under a live lease (a worker died on its last attempt), moved to `failed` before claiming. */
  abandonedAtCap: number
  /** Why the run stopped early, if a send failed. */
  stoppedOn: SinkErrorCategory | null
}

type ClaimedRow = {id: string; eventType: string; payload: unknown; createdAt: Date; attempts: number}

async function sweepAbandonedAtCap(tx: WorkerTx, maxAttempts: number): Promise<number> {
  const rows = await tx`
    update learner.event_outbox
    set status = 'failed', last_error = 'abandoned_at_attempt_cap', claimed_by = null, claimed_until = null
    where status = 'pending' and attempts >= ${maxAttempts} and (claimed_until is null or claimed_until < now())
      and event_type = any(${PROJECTED_EVENT_TYPES})
    returning id
  `
  return rows.length
}

async function claim(tx: WorkerTx, workerId: string, batchSize: number, leaseSeconds: number, maxAttempts: number) {
  return tx<ClaimedRow[]>`
    with due as (
      select id from learner.event_outbox
      where status = 'pending'
        and next_attempt_at <= now()
        and attempts < ${maxAttempts}
        and (claimed_until is null or claimed_until < now())
        and event_type = any(${PROJECTED_EVENT_TYPES})
      order by created_at, id
      limit ${batchSize}
      for update skip locked
    )
    update learner.event_outbox o
    set claimed_by = ${workerId},
        claimed_until = now() + make_interval(secs => ${leaseSeconds}),
        attempts = o.attempts + 1
    from due
    where o.id = due.id
    returning o.id, o.event_type as "eventType", o.payload, o.created_at as "createdAt", o.attempts
  `
}

async function syntheticIds(tx: WorkerTx, learnerIds: string[]): Promise<Set<string>> {
  if (learnerIds.length === 0) return new Set()
  const rows = await tx<{learnerId: string}[]>`
    select learner_id as "learnerId" from learner.synthetic_learner where learner_id = any(${learnerIds})
  `
  return new Set(rows.map((row) => row.learnerId))
}

/** Closes rows this worker still holds with a terminal status. */
async function closeClaimed(tx: WorkerTx, workerId: string, ids: string[], status: 'suppressed' | 'failed', reason: string) {
  if (ids.length === 0) return 0
  const rows = await tx`
    update learner.event_outbox
    set status = ${status}, last_error = ${reason}, claimed_by = null, claimed_until = null
    where id = any(${ids}) and claimed_by = ${workerId} and status = 'pending'
    returning id
  `
  return rows.length
}

/** Gives back a claim without using an attempt: for a row this worker cannot project. */
async function releaseHeld(tx: WorkerTx, workerId: string, ids: string[]) {
  if (ids.length === 0) return
  await tx`
    update learner.event_outbox
    set attempts = greatest(attempts - 1, 0), claimed_by = null, claimed_until = null
    where id = any(${ids}) and claimed_by = ${workerId} and status = 'pending'
  `
}

async function markDelivered(tx: WorkerTx, ids: string[]): Promise<number> {
  const rows = await tx`
    update learner.event_outbox
    set status = 'delivered', delivered_at = now(), last_error = null, claimed_by = null, claimed_until = null
    where id = any(${ids}) and status = 'pending'
    returning id
  `
  return rows.length
}

async function markRetry(
  tx: WorkerTx,
  workerId: string,
  ids: string[],
  category: SinkErrorCategory,
  {maxAttempts, backoffBaseSeconds, backoffCapSeconds}: Required<Pick<DispatchOptions, 'maxAttempts' | 'backoffBaseSeconds' | 'backoffCapSeconds'>>,
): Promise<{retried: number; deadLettered: number}> {
  const rows = await tx<{status: string}[]>`
    update learner.event_outbox
    set status = case when attempts >= ${maxAttempts} then 'failed' else 'pending' end,
        next_attempt_at = case
          when attempts >= ${maxAttempts} then next_attempt_at
          else now() + make_interval(secs => least(${backoffBaseSeconds}::float8 * power(2, attempts - 1), ${backoffCapSeconds}::float8))
        end,
        last_error = ${category},
        claimed_by = null,
        claimed_until = null
    where id = any(${ids}) and claimed_by = ${workerId} and status = 'pending'
    returning status
  `
  const deadLettered = rows.filter((row) => row.status === 'failed').length
  return {retried: rows.length - deadLettered, deadLettered}
}

export async function dispatchOutbox(options: DispatchOptions): Promise<DispatchSummary> {
  const {db, sink, workerId, recordRun = false} = options
  const batchSize = Math.min(Math.max(1, options.batchSize ?? DISPATCH_DEFAULTS.batchSize), MAX_BATCH_SIZE)
  const maxBatches = Math.max(1, options.maxBatches ?? DISPATCH_DEFAULTS.maxBatches)
  const leaseSeconds = Math.max(1, options.leaseSeconds ?? DISPATCH_DEFAULTS.leaseSeconds)
  const retry = {
    maxAttempts: Math.max(1, options.maxAttempts ?? DISPATCH_DEFAULTS.maxAttempts),
    backoffBaseSeconds: options.backoffBaseSeconds ?? DISPATCH_DEFAULTS.backoffBaseSeconds,
    backoffCapSeconds: options.backoffCapSeconds ?? DISPATCH_DEFAULTS.backoffCapSeconds,
  }

  const summary: DispatchSummary = {
    batches: 0,
    claimed: 0,
    delivered: 0,
    suppressed: 0,
    invalid: 0,
    retried: 0,
    deadLettered: 0,
    abandonedAtCap: 0,
    stoppedOn: null,
  }
  const runId = recordRun ? await startJobRun(db, 'outbox_dispatch', workerId) : null

  try {
    summary.abandonedAtCap = await asSignalsWorker(db, (tx) => sweepAbandonedAtCap(tx, retry.maxAttempts))

    while (summary.batches < maxBatches) {
      const batch = await asSignalsWorker(db, async (tx) => {
        const rows = await claim(tx, workerId, batchSize, leaseSeconds, retry.maxAttempts)
        const learnerIds = [...new Set(rows.map((row) => outboxLearnerId(row.payload)).filter((id): id is string => id !== null))]
        return {rows, synthetic: await syntheticIds(tx, learnerIds)}
      })
      if (batch.rows.length === 0) break
      summary.batches++
      summary.claimed += batch.rows.length

      const suppressed: string[] = []
      const held: string[] = []
      const invalid = new Map<string, string>()
      const events: CaptureEvent[] = []
      for (const row of batch.rows) {
        const learnerId = outboxLearnerId(row.payload)
        if (learnerId && batch.synthetic.has(learnerId)) {
          suppressed.push(row.id)
          continue
        }
        const projection = projectOutboxRow(row)
        if (projection.ok) events.push(projection.event)
        else if (projection.reason === 'unknown_event_type') held.push(row.id)
        else invalid.set(row.id, projection.reason)
      }

      await asSignalsWorker(db, async (tx) => {
        await releaseHeld(tx, workerId, held)
        summary.suppressed += await closeClaimed(tx, workerId, suppressed, 'suppressed', 'synthetic_learner')
        for (const reason of new Set(invalid.values())) {
          const ids = [...invalid].filter(([, why]) => why === reason).map(([id]) => id)
          summary.invalid += await closeClaimed(tx, workerId, ids, 'failed', reason)
        }
      })

      if (events.length === 0) continue
      const ids = events.map((event) => event.uuid)
      try {
        await sink.send(events)
      } catch (error) {
        const category = error instanceof SinkError ? error.category : 'network'
        const outcome = await asSignalsWorker(db, (tx) => markRetry(tx, workerId, ids, category, retry))
        summary.retried += outcome.retried
        summary.deadLettered += outcome.deadLettered
        summary.stoppedOn = category
        break
      }
      summary.delivered += await asSignalsWorker(db, (tx) => markDelivered(tx, ids))
    }
  } catch (error) {
    if (runId) {
      await finishJobRun(db, runId, {status: 'failed', counts: summary, error: error instanceof Error ? error.message : String(error)}).catch(
        () => undefined,
      )
    }
    throw error
  }

  if (runId) await finishJobRun(db, runId, {status: summary.stoppedOn ? 'failed' : 'succeeded', counts: summary, error: summary.stoppedOn})
  return summary
}
