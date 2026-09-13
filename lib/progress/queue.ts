/**
 * Orders one lesson's progress saves from the player. The server keeps the
 * last write it receives, so two saves in flight at once could land out of
 * order and store an older resume position. Here one save is sent at a
 * time; saves made meanwhile coalesce into the newest pending one, and a
 * requested completion is never dropped by coalescing.
 *
 * `flush` is for a page that is unloading: it cannot wait for the save in
 * flight, so it sends the newest position at once (the caller uses a
 * `keepalive` request), which may overlap that earlier save.
 */

export type ProgressSave = {positionSeconds: number; completed: boolean}

export type ProgressQueue = {
  save(next: ProgressSave): void
  flush(next: ProgressSave): void
}

/** `send` performs one request; a rejection is ignored so later saves still go out. */
export function createProgressQueue(send: (save: ProgressSave) => Promise<unknown>): ProgressQueue {
  let inFlight = false
  let pending: ProgressSave | null = null

  const merge = (next: ProgressSave) => {
    pending = {positionSeconds: next.positionSeconds, completed: next.completed || (pending?.completed ?? false)}
  }

  const drain = () => {
    if (inFlight || !pending) return
    const next = pending
    pending = null
    inFlight = true
    send(next)
      .catch(() => undefined)
      .finally(() => {
        inFlight = false
        drain()
      })
  }

  return {
    save(next) {
      merge(next)
      drain()
    },
    flush(next) {
      merge(next)
      if (!inFlight) return drain()
      const now = pending!
      pending = null
      void send(now).catch(() => undefined)
    },
  }
}
