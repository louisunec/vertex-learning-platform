import type postgres from 'postgres'

/**
 * Deterministic interleavings for database tests. `pauseAfterQuery` returns
 * a handle whose next transaction runs normally until its first query whose
 * SQL contains `fragment` has returned, then awaits `between()` (typically a
 * concurrent request run to completion on the plain handle) before going
 * on. It pauses once, so the race the test names happens on every run
 * instead of by timing.
 *
 * Only for tests: the pause holds the transaction open, so `between` must
 * not wait on a lock that transaction holds.
 */
export function pauseAfterQuery(sql: postgres.Sql, fragment: string, between: () => Promise<unknown>): postgres.Sql & {paused: () => boolean} {
  let paused = false
  const handle = new Proxy(sql, {
    get(target, prop, receiver) {
      if (prop === 'paused') return () => paused
      if (prop !== 'begin') return Reflect.get(target, prop, receiver)
      return (run: (tx: postgres.TransactionSql) => unknown) =>
        target.begin((tx) =>
          run(
            new Proxy(tx, {
              apply(query, self, args: unknown[]) {
                const pending = Reflect.apply(query as (...a: unknown[]) => unknown, self, args) as Promise<unknown>
                const strings = args[0] as readonly string[] | undefined
                if (paused || !Array.isArray(strings) || !strings.join('?').includes(fragment)) return pending
                paused = true
                return pending.then(async (rows) => {
                  await between()
                  return rows
                })
              },
            }),
          ),
        )
    },
  })
  return handle as postgres.Sql & {paused: () => boolean}
}
