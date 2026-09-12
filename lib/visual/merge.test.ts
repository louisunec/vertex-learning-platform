import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {isSameText, MAX_VISUAL_TEXT_LENGTH, mergeObservations, normalizeOcrText, type OcrObservation} from './merge.ts'

const at = (timestampSeconds: number, text: string, confidence: number | null = 90): OcrObservation => ({
  timestampSeconds,
  frameHash: `h${timestampSeconds}`,
  text,
  confidence,
  textDensity: 0.1,
})

const SLIDE = 'Introduction to React Hooks\nState and effects in function components'

describe('isSameText', () => {
  it('treats whitespace-only differences as equal', () => {
    assert.ok(isSameText('const  total =\t0', ' const total = 0 '))
  })

  it('keeps a one-character operator change distinct', () => {
    const before = 'function clamp(x) {\n  if (x < 10) {\n    return x\n  }\n  return 10\n}'
    assert.ok(!isSameText(before, before.replace('x < 10', 'x <= 10')))
    assert.ok(!isSameText('x < 10', 'x <= 10'))
  })

  it('keeps identifier and digit changes distinct even when highly similar', () => {
    const code = 'export function calculateTotal(items) {\n  return items.reduce((sum, item) => sum + item.price, 0)\n}'
    assert.ok(!isSameText(code, code.replace('item.price', 'item.prices')))
    assert.ok(!isSameText(code, code.replace(', 0)', ', 1)')))
    const assignment = 'let count = 0 // running total of all the items in the cart'
    assert.ok(!isSameText(assignment, assignment.replace('count', 'total')))
  })

  it('merges OCR noise in plain slide prose', () => {
    assert.ok(isSameText(SLIDE, SLIDE.replace('Introduction', 'Introducton')))
  })

  it('keeps short-word swaps and inserted words distinct', () => {
    assert.ok(!isSameText('Slide A title', 'Slide B title'))
    const rule = 'Hooks must be called at the top level of a component in every single render'
    assert.ok(!isSameText(rule, rule.replace('must be', 'must not be')))
    assert.ok(!isSameText(rule, rule.replace('every single', 'every')))
  })

  it('does not merge different slides', () => {
    assert.ok(!isSameText(SLIDE, 'Custom hooks\nShare stateful logic between components'))
  })
})

describe('mergeObservations', () => {
  it('merges a static screen into one chunk with its full interval', () => {
    const merged = mergeObservations([at(0, SLIDE), at(2, SLIDE), at(4, SLIDE)], 6)
    assert.deepEqual(
      merged.map((m) => [m.startSeconds, m.endSeconds]),
      [[0, 6]],
    )
  })

  it('keeps x < 10 and x <= 10 as separate chunks at the edit time', () => {
    const merged = mergeObservations([at(0, 'if (x < 10) {'), at(2, 'if (x < 10) {'), at(5, 'if (x <= 10) {'), at(8, 'if (x <= 10) {')], 10)
    assert.deepEqual(
      merged.map((m) => [m.text, m.startSeconds, m.endSeconds]),
      [
        ['if (x < 10) {', 0, 5],
        ['if (x <= 10) {', 5, 10],
      ],
    )
  })

  it('preserves appearance intervals: A, B, A yields three chunks', () => {
    const merged = mergeObservations([at(0, 'Slide A title'), at(3, 'Slide B title'), at(6, 'Slide A title')], 9)
    assert.deepEqual(
      merged.map((m) => [m.text, m.startSeconds, m.endSeconds]),
      [
        ['Slide A title', 0, 3],
        ['Slide B title', 3, 6],
        ['Slide A title', 6, 9],
      ],
    )
  })

  it('ends a run at a frame without text and starts nothing for it', () => {
    const merged = mergeObservations([at(0, SLIDE), at(2, ''), at(4, SLIDE)], 6)
    assert.deepEqual(
      merged.map((m) => [m.startSeconds, m.endSeconds]),
      [
        [0, 2],
        [4, 6],
      ],
    )
  })

  it('keeps the highest-confidence text, earliest on a tie, deterministically', () => {
    const noisy = SLIDE.replace('Introduction', 'Introducton')
    const observations = [at(0, noisy, 70), at(2, SLIDE, 95), at(4, noisy, 95)]
    const first = mergeObservations(observations, 6)
    assert.equal(first.length, 1)
    assert.equal(first[0].text, SLIDE)
    assert.equal(first[0].frame.timestampSeconds, 2)
    assert.deepEqual(mergeObservations(observations.toReversed(), 6), first)
  })

  it('rounds starts down and ends up to whole seconds', () => {
    const [merged] = mergeObservations([at(1.5, 'const a = 1')], 3.5)
    assert.deepEqual([merged.startSeconds, merged.endSeconds], [1, 4])
  })
})

describe('normalizeOcrText', () => {
  it('trims lines, drops blank lines, and clips at a line boundary', () => {
    assert.equal(normalizeOcrText('  a   b \n\n\t c  '), 'a b\nc')
    const line = 'x'.repeat(1000)
    const clipped = normalizeOcrText(Array(10).fill(line).join('\n'))
    assert.ok(clipped.length <= MAX_VISUAL_TEXT_LENGTH)
    assert.ok(clipped.split('\n').every((kept) => kept === line))
  })
})
