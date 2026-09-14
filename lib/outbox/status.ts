import type postgres from 'postgres'

import {asSignalsWorker} from '../db/worker-scope.ts'
import {PROJECTED_EVENT_TYPES} from './projection.ts'

/**
 * Operational view of the learner outbox (`npm run outbox -- status`) and
 * the dead-letter requeue (`npm run outbox -- requeue`). Reports ids, event
 * types, counts, and error categories only, never payloads.
 */

export type OutboxStatus = {
  byStatus: Array<{status: string; eventType: string; count: number}>
  /** Pending rows of an event type with no approved projection: never claimed or sent, kept until one is added. */
  held: Array<{eventType: string; count: number; oldestSeconds: number}>
  /** Deliverable pending rows due now and not under a live lease. */
  dueNow: number
  /** Pending rows waiting for their backoff to pass. */
  backingOff: number
  /** Rows under a live lease (a dispatcher is sending them). */
  inFlight: number
  /** Pending rows whose lease expired without a result: recovered by the next run. */
  abandonedClaims: number
  oldestPendingSeconds: number | null
  failed: Array<{id: string; eventType: string; attempts: number; lastError: string | null; createdAt: Date}>
}

export async function outboxStatus(db: postgres.Sql, {failedLimit = 20}: {failedLimit?: number} = {}): Promise<OutboxStatus> {
  return asSignalsWorker(db, async (tx) => {
    const byStatus = await tx<{status: string; eventType: string; count: number}[]>`
      select status, event_type as "eventType", count(*)::int as count
      from learner.event_outbox group by status, event_type order by status, event_type
    `
    const [pending] = await tx<
      {dueNow: number; backingOff: number; inFlight: number; abandonedClaims: number; oldestPendingSeconds: number | null}[]
    >`
      select
        count(*) filter (where next_attempt_at <= now() and (claimed_until is null or claimed_until < now()))::int as "dueNow",
        count(*) filter (where next_attempt_at > now() and (claimed_until is null or claimed_until < now()))::int as "backingOff",
        count(*) filter (where claimed_until >= now())::int as "inFlight",
        count(*) filter (where claimed_until < now())::int as "abandonedClaims",
        extract(epoch from now() - min(created_at))::float8 as "oldestPendingSeconds"
      from learner.event_outbox where status = 'pending' and event_type = any(${PROJECTED_EVENT_TYPES})
    `
    const held = await tx<OutboxStatus['held']>`
      select event_type as "eventType", count(*)::int as count, extract(epoch from now() - min(created_at))::float8 as "oldestSeconds"
      from learner.event_outbox where status = 'pending' and event_type <> all(${PROJECTED_EVENT_TYPES})
      group by event_type order by event_type
    `
    const failed = await tx<OutboxStatus['failed']>`
      select id, event_type as "eventType", attempts, last_error as "lastError", created_at as "createdAt"
      from learner.event_outbox where status = 'failed'
      order by created_at desc limit ${failedLimit}
    `
    return {...pending, byStatus, held, failed}
  })
}

/** Moves dead-lettered rows back to `pending` with a fresh attempt budget. Returns the number requeued. */
export async function requeueFailed(
  db: postgres.Sql,
  {eventType = null, limit = 1000}: {eventType?: string | null; limit?: number} = {},
): Promise<number> {
  return asSignalsWorker(db, async (tx) => {
    const rows = await tx`
      update learner.event_outbox
      set status = 'pending', attempts = 0, next_attempt_at = now(), last_error = 'requeued', claimed_by = null, claimed_until = null
      where id in (
        select id from learner.event_outbox
        where status = 'failed' and (${eventType}::text is null or event_type = ${eventType})
        order by created_at limit ${limit}
        for update skip locked
      )
      returning id
    `
    return rows.length
  })
}
