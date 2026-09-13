import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {MAX_TERMS} from '../search/terms.ts'
import {chunkSearchParams} from './source.ts'
import {deterministicTerms, listTerms, MAX_LIST_TERMS, mergeTerms} from './terms.ts'

describe('deterministic tutor terms', () => {
  it('adds the pros-and-cons words a lesson uses, cons first, without a model', () => {
    assert.deepEqual(deterministicTerms('What are the downsides of a high temperature?'), {
      baseTerms: ['downside', 'high', 'temperature'],
      terms: ['downside', 'high', 'temperature', 'cons', 'drawback', 'disadvantage', 'limitation'],
    })
    assert.deepEqual(listTerms('Any advantages?'), ['pros', 'benefit', 'upside', 'strength'])
    assert.deepEqual(listTerms('What are the pros and cons?'), ['downside', 'drawback', 'disadvantage', 'limitation'])
    assert.deepEqual(listTerms('What are the weaknesses?'), ['cons', 'downside', 'drawback', 'disadvantage'])
  })

  it('never adds pro or con stems, and ignores look-alike words', () => {
    for (const question of ['Why is the probability constant?', 'What does the process return?', 'Explain the context window']) {
      assert.deepEqual(listTerms(question), [], question)
    }
    const all = [...listTerms('downsides'), ...listTerms('advantages')]
    assert.equal(all.some((term) => term === 'pro' || term === 'con'), false)
    assert.ok(listTerms('downsides, drawbacks, benefits and upsides').length <= MAX_LIST_TERMS)
  })

  it('keeps a question with no topic words on the window', () => {
    assert.deepEqual(deterministicTerms('What does this mean?'), {baseTerms: [], terms: []})
  })

  it('caps the terms, keeps the learner terms first, and sanitizes untrusted variants', () => {
    const merged = mergeTerms(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9'], ['cons'], Array.from({length: 10}, (_, i) => `variant${i}`))
    assert.equal(merged.length, MAX_TERMS)
    assert.deepEqual(merged.slice(0, 9), ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'cons'])
    assert.deepEqual(mergeTerms(['downside'], [], ['Cons', 'drawbacks; DROP *', '"}]']), ['downside', 'con', 'drawback', 'drop'])
    // Every produced term is accepted by the GROQ param guard.
    const {terms} = deterministicTerms('"}]; DROP * downsides of *high* temperature?!')
    assert.doesNotThrow(() => chunkSearchParams(['v'], terms, null))
  })
})
