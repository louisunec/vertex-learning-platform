import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {summarizeOcrPage} from './ocr.ts'

const word = (text: string, confidence: number, x0 = 0) => ({text, confidence, bbox: {x0, y0: 0, x1: x0 + 10, y1: 10}})
const page = (lines: Array<{text: string; words: ReturnType<typeof word>[]}>) => ({blocks: [{paragraphs: [{lines}]}]})
const size = {width: 100, height: 100}

describe('summarizeOcrPage', () => {
  it('joins lines and weights confidence by word length', () => {
    const result = summarizeOcrPage(
      page([
        {text: 'if (x <= 10) {\n', words: [word('if', 90), word('(x', 90), word('<=', 60), word('10)', 90), word('{', 90)]},
        {text: 'return x\n', words: [word('return', 96), word('x', 96)]},
      ]),
      size,
    )
    assert.equal(result.text, 'if (x <= 10) {\nreturn x')
    assert.equal(result.confidence, 88.9)
    assert.equal(result.textDensity, 0.07)
  })

  it('reports no words as no text with null confidence', () => {
    assert.deepEqual(summarizeOcrPage({blocks: null}, size), {text: '', confidence: null, textDensity: 0})
  })

  it('drops low-confidence or near-empty text, keeping its confidence but no coverage for the gate', () => {
    const garbled = summarizeOcrPage(page([{text: 'ljl~ |=\n', words: [word('ljl~', 20), word('|=', 25)]}]), size)
    assert.equal(garbled.text, '')
    assert.equal(garbled.confidence, 21.7)
    assert.equal(garbled.textDensity, 0)
    const tiny = summarizeOcrPage(page([{text: 'a |\n', words: [word('a', 95), word('|', 95)]}]), size)
    assert.equal(tiny.text, '')
  })
})
