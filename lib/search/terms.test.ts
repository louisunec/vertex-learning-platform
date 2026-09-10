import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {countTermHits, fallbackTerms, sanitizeTerms, tokenize} from './terms.ts'

describe('tokenize', () => {
  it('lowercases, strips unsafe characters, and deduplicates', () => {
    assert.deepEqual(tokenize('CSS Grid! grid *[_type=="x"]'), ['css', 'grid', 'type'])
  })

  it('drops one-character and over-long tokens', () => {
    assert.deepEqual(tokenize(`a bb ${'x'.repeat(33)}`), ['bb'])
  })
})

describe('sanitizeTerms', () => {
  it('rejects non-strings and enforces safe tokens', () => {
    assert.deepEqual(sanitizeTerms(['Flex-Box', 42 as unknown as string, '"; drop', 'flex-box']), [
      'flex-box',
      'drop',
    ])
  })

  it('caps the number of terms at 12', () => {
    const many = Array.from({length: 30}, (_, i) => `term${i}`)
    assert.equal(sanitizeTerms(many).length, 12)
  })
})

describe('fallbackTerms', () => {
  it('removes stopwords', () => {
    assert.deepEqual(fallbackTerms('how do I learn css grid'), ['css', 'grid'])
  })

  it('falls back to raw tokens when only stopwords remain', () => {
    assert.deepEqual(fallbackTerms('how to learn'), ['how', 'to', 'learn'])
  })
})

describe('countTermHits', () => {
  it('counts prefix matches case-insensitively', () => {
    assert.equal(countTermHits('Understanding CSS Grid Layouts', ['css', 'grid', 'layout']), 3)
  })

  it('returns 0 for empty text', () => {
    assert.equal(countTermHits(null, ['css']), 0)
  })
})
