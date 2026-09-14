import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {AGAIN, decideRating, GOOD, type RatingFacts} from './rating.ts'

describe('decideRating', () => {
  it('rates an unassisted correct answer Good and any incorrect answer Again', () => {
    assert.deepEqual(decideRating({correct: true, hintLevelUsed: 0, answerExposed: false}), {outcome: 'rated', rating: GOOD})
    assert.deepEqual(decideRating({correct: false, hintLevelUsed: 0, answerExposed: false}), {outcome: 'rated', rating: AGAIN})
    assert.deepEqual(decideRating({correct: false, hintLevelUsed: 2, answerExposed: false}), {outcome: 'rated', rating: AGAIN})
    assert.deepEqual(decideRating({correct: false, hintLevelUsed: 3, answerExposed: true}), {outcome: 'rated', rating: AGAIN})
  })

  it('never rates an assisted correct answer', () => {
    for (const facts of [
      {correct: true, hintLevelUsed: 1, answerExposed: false},
      {correct: true, hintLevelUsed: 2, answerExposed: false},
      {correct: true, hintLevelUsed: 3, answerExposed: true},
      {correct: true, hintLevelUsed: 0, answerExposed: true},
    ]) {
      assert.deepEqual(decideRating(facts), {outcome: 'unrated_assisted_correct'}, JSON.stringify(facts))
    }
  })

  it('has no self-confidence input', () => {
    const facts = {correct: true, hintLevelUsed: 0, answerExposed: false}
    // @ts-expect-error self-confidence is not a rating input (typecheck enforces this line)
    const withConfidence: RatingFacts = {...facts, selfConfidence: 5}
    // An extra key reaching it at runtime changes nothing either.
    assert.deepEqual(decideRating(withConfidence), decideRating(facts))
    assert.deepEqual(decideRating({...facts, correct: false, selfConfidence: 1} as RatingFacts), {outcome: 'rated', rating: AGAIN})
  })
})
