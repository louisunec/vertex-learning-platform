import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {classifySeek, MAX_SEEKS_PER_VIEW, SeekTracker, type ProgrammaticSeek} from './seek.ts'

/** Plays from `from` for `seconds`, one sample per second, starting at `at` ms. */
function play(tracker: SeekTracker, from: number, seconds: number, at: number) {
  const seeks = []
  for (let step = 0; step <= seconds; step++) {
    const seek = tracker.sample(from + step, at + step * 1000, {playing: true})
    if (seek) seeks.push(seek)
  }
  return seeks
}

describe('SeekTracker', () => {
  it('reports nothing for normal playback, including a deep-linked start', () => {
    const tracker = new SeekTracker()
    assert.deepEqual(play(tracker, 120, 30, 0), [])
    assert.equal(tracker.flush(), null)
  })

  it('reports a backward jump as a replay once playback settles', () => {
    const tracker = new SeekTracker()
    play(tracker, 0, 60, 0)
    // At 60 s the learner drags back to 30 s and keeps watching.
    assert.equal(tracker.sample(30, 61_000, {playing: true}), null)
    const seek = tracker.sample(31, 62_000, {playing: true})
    assert.deepEqual(seek, {fromSeconds: 61, toSeconds: 30, kind: 'replay', origin: 'learner'})
  })

  it('merges rapid scrubbing into one seek from the original position', () => {
    const tracker = new SeekTracker()
    play(tracker, 0, 100, 0)
    tracker.sample(80, 101_000, {playing: true})
    tracker.sample(50, 102_000, {playing: true})
    tracker.sample(40, 103_000, {playing: true})
    assert.deepEqual(tracker.sample(41, 104_000, {playing: true}), {fromSeconds: 101, toSeconds: 40, kind: 'replay', origin: 'learner'})
  })

  it('does not mistake a pause, buffering, or a faster playback rate for a seek', () => {
    const tracker = new SeekTracker()
    play(tracker, 0, 10, 0)
    tracker.sample(10.2, 10_200, {playing: false}) // buffering or pause
    assert.equal(tracker.sample(10.2, 40_000, {playing: true}), null) // resumes 30 s later where it stopped
    assert.equal(tracker.sample(11.2, 41_000, {playing: true}), null)

    const fast = new SeekTracker()
    for (let step = 0; step <= 20; step++) assert.equal(fast.sample(step * 2, step * 1000, {playing: true, rate: 2}), null)
  })

  it('detects a scrub made while paused when playback resumes', () => {
    const tracker = new SeekTracker()
    play(tracker, 0, 90, 0)
    tracker.sample(90, 90_500, {playing: false})
    assert.equal(tracker.sample(20, 120_000, {playing: true}), null)
    assert.deepEqual(tracker.sample(21, 121_000, {playing: true}), {fromSeconds: 90, toSeconds: 20, kind: 'replay', origin: 'learner'})
  })

  it('classifies skips and far rewinds apart from replays', () => {
    assert.equal(classifySeek(100, 70), 'replay')
    assert.equal(classifySeek(300, 100), 'rewind_far')
    assert.equal(classifySeek(100, 200), 'skip')
    const tracker = new SeekTracker()
    play(tracker, 0, 10, 0)
    tracker.sample(200, 11_000, {playing: true})
    assert.equal(tracker.sample(201, 12_000, {playing: true})?.kind, 'skip')
  })

  it('labels a jump to a tutor citation target as citation, not learner', () => {
    let page: ProgrammaticSeek | null = null
    const tracker = new SeekTracker(() => page)
    play(tracker, 0, 100, 0)
    page = {seconds: 42, at: 100_500}
    tracker.sample(42, 101_000, {playing: true})
    assert.deepEqual(tracker.sample(43, 102_000, {playing: true}), {fromSeconds: 101, toSeconds: 42, kind: 'replay', origin: 'citation'})

    // A learner seek long after the citation is the learner's again.
    tracker.sample(60, 103_000, {playing: true})
    play(tracker, 60, 30, 103_000)
    tracker.sample(40, 134_000, {playing: true})
    assert.equal(tracker.sample(41, 135_000, {playing: true})?.origin, 'learner')
  })

  it('reports a seek still settling at the end, and caps seeks per page view', () => {
    const tracker = new SeekTracker()
    play(tracker, 0, 10, 0)
    tracker.sample(3, 11_000, {playing: false})
    assert.equal(tracker.flush()?.kind, 'replay')

    const busy = new SeekTracker()
    let at = 0
    let reported = 0
    busy.sample(500, at, {playing: false})
    // Each cycle: jump to 100 and settle there, then jump to 500 and settle there (two seeks).
    for (let index = 0; index < MAX_SEEKS_PER_VIEW; index++) {
      for (const position of [100, 100, 500, 500]) {
        at += 1000
        if (busy.sample(position, at, {playing: false})) reported++
      }
    }
    assert.equal(reported, MAX_SEEKS_PER_VIEW)
  })
})
