import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {createProgressQueue, type ProgressSave} from './queue.ts'

/** A fake transport whose requests settle only when the test says so. */
function transport() {
  const sent: ProgressSave[] = []
  const settle: Array<(ok: boolean) => void> = []
  const send = (save: ProgressSave) => {
    sent.push(save)
    return new Promise<void>((resolve, reject) => settle.push((ok) => (ok ? resolve() : reject(new Error('offline')))))
  }
  const finish = async (ok = true) => {
    settle.shift()?.(ok)
    // Let `.catch().finally()` run and the next save go out.
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }
  return {sent, send, finish}
}

const at = (positionSeconds: number, completed = false): ProgressSave => ({positionSeconds, completed})

describe('createProgressQueue', () => {
  it('keeps one save in flight and sends only the newest pending position after it', async () => {
    const t = transport()
    const queue = createProgressQueue(t.send)
    queue.save(at(15))
    queue.save(at(30))
    queue.save(at(20))
    assert.deepEqual(t.sent, [at(15)])
    await t.finish()
    assert.deepEqual(t.sent, [at(15), at(20)])
    await t.finish()
    assert.equal(t.sent.length, 2)
  })

  it('never drops a completion when a later save coalesces over it', async () => {
    const t = transport()
    const queue = createProgressQueue(t.send)
    queue.save(at(10))
    queue.save(at(90, true))
    queue.save(at(95))
    await t.finish()
    assert.deepEqual(t.sent.at(-1), at(95, true))
  })

  it('keeps going after a failed save', async () => {
    const t = transport()
    const queue = createProgressQueue(t.send)
    queue.save(at(10))
    queue.save(at(25))
    await t.finish(false)
    assert.deepEqual(t.sent, [at(10), at(25)])
  })

  it('flushes at once for an unloading page, even with a save in flight', async () => {
    const t = transport()
    const queue = createProgressQueue(t.send)
    queue.flush(at(5))
    assert.deepEqual(t.sent, [at(5)])
    queue.save(at(12))
    queue.flush(at(14))
    assert.deepEqual(t.sent, [at(5), at(14)])
    await t.finish()
    await t.finish()
    assert.equal(t.sent.length, 2)
  })
})
