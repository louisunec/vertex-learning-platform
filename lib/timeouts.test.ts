import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {MAX_TIMEOUT_MS, MIN_TIMEOUT_MS, readTimeoutMs} from './timeouts.ts'

describe('readTimeoutMs', () => {
  it('uses the default when the variable is unset or blank', () => {
    assert.equal(readTimeoutMs('X_TIMEOUT_MS', 10_000, {}), 10_000)
    assert.equal(readTimeoutMs('X_TIMEOUT_MS', 10_000, {X_TIMEOUT_MS: '  '}), 10_000)
  })

  it('accepts an integer override within bounds', () => {
    assert.equal(readTimeoutMs('X_TIMEOUT_MS', 10_000, {X_TIMEOUT_MS: '12000'}), 12_000)
    assert.equal(readTimeoutMs('X_TIMEOUT_MS', 10_000, {X_TIMEOUT_MS: String(MIN_TIMEOUT_MS)}), MIN_TIMEOUT_MS)
    assert.equal(readTimeoutMs('X_TIMEOUT_MS', 10_000, {X_TIMEOUT_MS: String(MAX_TIMEOUT_MS)}), MAX_TIMEOUT_MS)
  })

  it('falls back on invalid or out-of-range values instead of dropping the bound', () => {
    for (const raw of ['abc', '1.5', '0', '-5000', '999', '60001', 'Infinity']) {
      assert.equal(readTimeoutMs('X_TIMEOUT_MS', 10_000, {X_TIMEOUT_MS: raw}), 10_000, raw)
    }
  })
})
