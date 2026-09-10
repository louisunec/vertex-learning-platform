import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {reachedMilestones, type WatchDepthMilestone} from './watch-depth.ts'

const none = new Set<WatchDepthMilestone>()

describe('reachedMilestones', () => {
  it('returns every milestone at or below the current position', () => {
    assert.deepEqual(reachedMilestones({positionSeconds: 10, durationSeconds: 100, startSeconds: null, reported: none}), [])
    assert.deepEqual(reachedMilestones({positionSeconds: 25, durationSeconds: 100, startSeconds: null, reported: none}), [25])
    assert.deepEqual(
      reachedMilestones({positionSeconds: 80, durationSeconds: 100, startSeconds: 0, reported: none}),
      [25, 50, 75],
    )
  })

  it('reports all milestones when playback ends', () => {
    assert.deepEqual(
      reachedMilestones({positionSeconds: 100, durationSeconds: 100, startSeconds: null, reported: none}),
      [25, 50, 75, 90],
    )
  })

  it('skips milestones already reported', () => {
    assert.deepEqual(
      reachedMilestones({positionSeconds: 60, durationSeconds: 100, startSeconds: null, reported: new Set([25])}),
      [50],
    )
  })

  it('never counts milestones at or below the start position', () => {
    assert.deepEqual(reachedMilestones({positionSeconds: 60, durationSeconds: 100, startSeconds: 60, reported: none}), [])
    assert.deepEqual(reachedMilestones({positionSeconds: 76, durationSeconds: 100, startSeconds: 50, reported: none}), [75])
  })

  it('returns nothing without a usable duration or position', () => {
    assert.deepEqual(reachedMilestones({positionSeconds: 50, durationSeconds: 0, startSeconds: null, reported: none}), [])
    assert.deepEqual(reachedMilestones({positionSeconds: NaN, durationSeconds: 100, startSeconds: null, reported: none}), [])
  })
})
