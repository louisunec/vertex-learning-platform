import {randomUUID} from 'node:crypto'
import {hostname} from 'node:os'
import {parseArgs} from 'node:util'

import postgres from 'postgres'

import {recentJobRuns} from '../lib/db/job-run.ts'
import {asSignalsWorker} from '../lib/db/worker-scope.ts'
import {dispatchOutbox, DISPATCH_DEFAULTS} from '../lib/outbox/dispatch.ts'
import {createPostHogSink} from '../lib/outbox/posthog-sink.ts'
import {outboxLearnerId, projectOutboxRow} from '../lib/outbox/projection.ts'
import {outboxStatus, requeueFailed} from '../lib/outbox/status.ts'

/**
 * The learner outbox (development plan §5 PR-10). Offline tooling, never in
 * the request path; see docs/EDITORIAL_SIGNALS.md.
 *
 *   npm run outbox -- dispatch                     # deliver due events to PostHog
 *   npm run outbox -- dispatch --dry-run           # show what would be sent; sends and claims nothing
 *   npm run outbox -- dispatch --batch-size 50 --max-batches 20
 *   npm run outbox -- status                       # counts, in-flight and abandoned claims, dead letters
 *   npm run outbox -- requeue [--event-type attempt_graded] [--limit 100]
 *
 * Needs DATABASE_URL (the database owner connection; every query runs as
 * `vertex_signals_worker`), and for dispatch NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN
 * and NEXT_PUBLIC_POSTHOG_HOST. Delivery is at-least-once with the outbox
 * row id as the event uuid; exactly-once is not claimed.
 */

const {positionals, values} = parseArgs({
  allowPositionals: true,
  options: {
    'dry-run': {type: 'boolean', default: false},
    'batch-size': {type: 'string'},
    'max-batches': {type: 'string'},
    'lease-seconds': {type: 'string'},
    'event-type': {type: 'string'},
    limit: {type: 'string'},
  },
})
const command = positionals[0]
if (!['dispatch', 'status', 'requeue'].includes(command ?? '')) {
  console.error('Usage: npm run outbox -- dispatch [--dry-run] | status | requeue [--event-type <type>] [--limit <n>]')
  process.exit(1)
}

const url = process.env.DATABASE_URL?.trim()
if (!url) {
  console.error('DATABASE_URL is not set (see .env.example).')
  process.exit(1)
}

const int = (value: string | undefined, fallback: number) => {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.error(`Expected a positive whole number, got "${value}".`)
    process.exit(1)
  }
  return parsed
}

const db = postgres(url, {max: 2, prepare: false, onnotice: () => {}, connection: {application_name: 'vertex-outbox'}})
const workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`

try {
  if (command === 'status') {
    const status = await outboxStatus(db)
    console.log('By status and event type:')
    for (const row of status.byStatus) console.log(`  ${row.status.padEnd(10)} ${row.eventType.padEnd(20)} ${row.count}`)
    if (status.byStatus.length === 0) console.log('  (empty)')
    console.log(`\nPending: ${status.dueNow} due now, ${status.backingOff} backing off, ${status.inFlight} in flight, ${status.abandonedClaims} abandoned claim(s)`)
    if (status.held.length > 0) {
      console.log('\nHeld: no approved projection in lib/outbox/projection.ts, so never claimed or sent (kept pending):')
      for (const row of status.held) console.log(`  ${row.eventType.padEnd(20)} ${row.count}  oldest ${Math.round(row.oldestSeconds)} s`)
    }
    if (status.oldestPendingSeconds !== null) console.log(`Oldest pending: ${Math.round(status.oldestPendingSeconds)} s`)
    if (status.failed.length > 0) {
      console.log('\nDead letters (latest):')
      for (const row of status.failed) {
        console.log(`  ${row.id}  ${row.eventType}  attempts=${row.attempts}  ${row.lastError ?? ''}  ${row.createdAt.toISOString()}`)
      }
    }
    const runs = await recentJobRuns(db, 'outbox_dispatch')
    if (runs.length > 0) {
      console.log('\nRecent dispatch runs:')
      for (const run of runs) {
        console.log(`  ${run.startedAt.toISOString()}  ${run.status.padEnd(9)}  ${JSON.stringify(run.counts)}${run.error ? `  ${run.error}` : ''}`)
      }
    }
  } else if (command === 'requeue') {
    const count = await requeueFailed(db, {eventType: values['event-type'] ?? null, limit: int(values.limit, 1000)})
    console.log(`Requeued ${count} dead-lettered event(s).`)
  } else if (values['dry-run']) {
    // Reads due rows without claiming them, and prints exactly what would leave the database.
    const rows = await asSignalsWorker(
      db,
      (tx) => tx<{id: string; eventType: string; payload: unknown; createdAt: Date}[]>`
        select id, event_type as "eventType", payload, created_at as "createdAt" from learner.event_outbox
        where status = 'pending' and next_attempt_at <= now() and (claimed_until is null or claimed_until < now())
        order by created_at, id limit ${int(values['batch-size'], DISPATCH_DEFAULTS.batchSize)}
      `,
    )
    const synthetic = await asSignalsWorker(db, (tx) => tx<{learnerId: string}[]>`select learner_id as "learnerId" from learner.synthetic_learner`)
    const suppressed = new Set(synthetic.map((row) => row.learnerId))
    console.log(`${rows.length} due event(s) (dry run: nothing claimed or sent)\n`)
    for (const row of rows) {
      const learnerId = outboxLearnerId(row.payload)
      if (learnerId && suppressed.has(learnerId)) {
        console.log(`${row.id}  ${row.eventType}  → suppressed (synthetic learner)`)
        continue
      }
      const projection = projectOutboxRow(row)
      console.log(
        projection.ok
          ? `${row.id}  ${row.eventType}  distinct_id=<learner>  ${JSON.stringify(projection.event.properties)}`
          : projection.reason === 'unknown_event_type'
            ? `${row.id}  ${row.eventType}  → held (no approved projection; stays pending, never sent)`
            : `${row.id}  ${row.eventType}  → dead letter (${projection.reason})`,
      )
    }
  } else {
    const token = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN?.trim()
    const host = process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim()
    if (!token || !host || !/^https?:\/\//.test(host)) {
      console.error('NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN and NEXT_PUBLIC_POSTHOG_HOST (an https URL) are required to dispatch.')
      process.exitCode = 1
    } else {
      const summary = await dispatchOutbox({
        db,
        sink: createPostHogSink({host, projectToken: token}),
        workerId,
        batchSize: int(values['batch-size'], DISPATCH_DEFAULTS.batchSize),
        maxBatches: int(values['max-batches'], DISPATCH_DEFAULTS.maxBatches),
        leaseSeconds: int(values['lease-seconds'], DISPATCH_DEFAULTS.leaseSeconds),
        recordRun: true,
      })
      console.log(JSON.stringify(summary, null, 2))
      if (summary.stoppedOn) {
        console.error(`Stopped early: ${summary.stoppedOn}. Failed events retry after their backoff.`)
        process.exitCode = 1
      }
    }
  }
} catch (error) {
  console.error('outbox failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  await db.end()
}
