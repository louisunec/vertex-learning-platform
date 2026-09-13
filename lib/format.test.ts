import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {formatClock, formatDuration, formatLevel, formatRelativeTime, pluralize} from './format.ts'

describe('formatDuration', () => {
  it('renders hours and minutes', () => {
    assert.equal(formatDuration(18 * 3600 + 24 * 60), '18h 24m')
    assert.equal(formatDuration(3600 + 12 * 60), '1h 12m')
  })
  it('renders minutes only under an hour', () => {
    assert.equal(formatDuration(45 * 60), '45m')
    assert.equal(formatDuration(1226), '20m')
  })
  it('renders seconds under a minute and never goes negative', () => {
    assert.equal(formatDuration(50), '50s')
    assert.equal(formatDuration(-5), '0s')
  })
  it('carries a rounded 60th minute into the hour', () => {
    assert.equal(formatDuration(3599.6), '1h 0m')
    assert.equal(formatDuration(7169), '1h 59m')
  })
})

describe('formatClock', () => {
  it('renders m:ss and h:mm:ss', () => {
    assert.equal(formatClock(765), '12:45')
    assert.equal(formatClock(350), '5:50')
    assert.equal(formatClock(3723), '1:02:03')
    assert.equal(formatClock(0), '0:00')
  })
  it('pads minutes on request', () => {
    assert.equal(formatClock(341, {pad: true}), '05:41')
    assert.equal(formatClock(765, {pad: true}), '12:45')
    assert.equal(formatClock(3723, {pad: true}), '1:02:03')
  })
})

describe('formatLevel / pluralize', () => {
  it('capitalises the stored enum', () => {
    assert.equal(formatLevel('intermediate'), 'Intermediate')
  })
  it('pluralises counts', () => {
    assert.equal(pluralize(1, 'module'), '1 module')
    assert.equal(pluralize(12, 'module'), '12 modules')
  })
})

describe('formatRelativeTime', () => {
  const now = new Date('2026-09-13T12:00:00Z')
  it('uses the largest whole unit', () => {
    assert.equal(formatRelativeTime('2026-09-13T10:00:00Z', now), '2 hours ago')
    assert.equal(formatRelativeTime('2026-09-12T11:00:00Z', now), '1 day ago')
    assert.equal(formatRelativeTime('2026-09-13T11:15:00Z', now), '45 minutes ago')
    assert.equal(formatRelativeTime('2026-08-20T12:00:00Z', now), '3 weeks ago')
  })
  it('says just now under a minute and for future timestamps', () => {
    assert.equal(formatRelativeTime('2026-09-13T11:59:30Z', now), 'just now')
    assert.equal(formatRelativeTime('2026-09-13T12:05:00Z', now), 'just now')
  })
})
