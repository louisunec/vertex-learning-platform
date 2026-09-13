import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {blockChange, createFrameSelector, edgeDensity, frameHash, type GrayFrame} from './sampling.ts'

const W = 320
const H = 180

function frame(timestampSeconds: number, paint?: (x: number, y: number) => number | undefined): GrayFrame {
  const pixels = new Uint8Array(W * H).fill(20)
  if (paint) {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) pixels[y * W + x] = paint(x, y) ?? 20
  }
  return {timestampSeconds, width: W, height: H, pixels}
}

/** Glyph-like vertical strokes across a text line (y 32–47, x 16–271). */
const textLine = (x: number, y: number) => (y >= 32 && y < 48 && x >= 16 && x < 272 && x % 3 === 0 ? 230 : undefined)
/** The same line with one "character" (x 64–79) changed to horizontal strokes. */
const editedLine = (x: number, y: number) =>
  x >= 64 && x < 80 && y >= 32 && y < 48 ? (y % 3 === 0 ? 230 : 20) : textLine(x, y)
/** A smooth bright rectangle (a "head") at horizontal offset `dx`. */
const head = (dx: number) => (x: number, y: number) => (x >= 100 + dx && x < 180 + dx && y >= 40 && y < 150 ? 200 : undefined)

describe('frame metrics', () => {
  it('measures text-like edges and ignores flat frames', () => {
    assert.equal(edgeDensity(frame(0)), 0)
    assert.ok(edgeDensity(frame(0, textLine)) > edgeDensity(frame(0, head(0))))
  })

  it('hashes identical frames alike and changed frames differently', () => {
    assert.equal(frameHash(frame(0, textLine)), frameHash(frame(5, textLine)))
    assert.notEqual(frameHash(frame(0, textLine)), frameHash(frame(0, editedLine)))
  })

  it('counts a one-character edit as text-region change', () => {
    const change = blockChange(frame(0, textLine), frame(1, editedLine))
    assert.ok(change.text > 0)
  })

  it('counts a moving smooth shape as plain change, not text change', () => {
    const change = blockChange(frame(0, head(0)), frame(1, head(24)))
    assert.equal(change.text, 0)
    assert.ok(change.weighted > 0)
  })
})

describe('createFrameSelector', () => {
  it('keeps periodic frames of a static screen', () => {
    const selector = createFrameSelector({periodicSeconds: 2, sceneTimes: []})
    const kept = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4].map((t) => selector.consider(frame(t, textLine)))
    assert.deepEqual(
      kept.filter(Boolean).map((f) => f!.timestampSeconds),
      [0, 2, 4],
    )
  })

  it('keeps the frame where a one-character edit appears, between periodic frames', () => {
    const selector = createFrameSelector({periodicSeconds: 2, sceneTimes: []})
    selector.consider(frame(0, textLine))
    assert.equal(selector.consider(frame(0.5, textLine)), null)
    const edit = selector.consider(frame(1, editedLine))
    assert.ok(edit?.signals.textChange)
    assert.equal(edit?.signals.periodic, false)
    assert.equal(selector.consider(frame(1.5, editedLine)), null)
  })

  it('keeps the analysis frame nearest a scene change', () => {
    const selector = createFrameSelector({periodicSeconds: 10, sceneTimes: [1.2]})
    selector.consider(frame(0))
    assert.equal(selector.consider(frame(0.5)), null)
    assert.ok(selector.consider(frame(1))?.signals.scene)
    assert.equal(selector.consider(frame(1.5)), null)
  })

  it('does not keep extra frames for a moving smooth shape', () => {
    const selector = createFrameSelector({periodicSeconds: 2, sceneTimes: []})
    const kept = [0, 0.5, 1, 1.5, 2].map((t, i) => selector.consider(frame(t, head(i * 12))))
    assert.deepEqual(
      kept.filter(Boolean).map((f) => f!.timestampSeconds),
      [0, 2],
    )
    assert.ok(kept[4]!.visualChange > 0)
  })
})
