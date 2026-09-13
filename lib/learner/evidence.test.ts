import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {applyEvidence, classifyEvidence, EMPTY_COUNTS, projectMastery, type MasteryCounts} from './evidence.ts'

describe('classifyEvidence', () => {
  it('counts only an unaided first response to a family as independent', () => {
    assert.deepEqual(classifyEvidence({priorFamilyAttempts: 0, helpLevelUsed: 0}), {
      kind: 'independent',
      reason: 'first_independent_response',
    })
  })

  it('treats hints before answering as assisted', () => {
    for (const level of [1, 2]) {
      assert.deepEqual(classifyEvidence({priorFamilyAttempts: 0, helpLevelUsed: level}), {kind: 'assisted', reason: 'hint_used'})
    }
  })

  it('records a response after the solution was shown as answer exposure', () => {
    assert.deepEqual(classifyEvidence({priorFamilyAttempts: 0, helpLevelUsed: 3}), {kind: 'assisted', reason: 'answer_exposed'})
  })

  it('never counts a repeat of the same family, with or without help', () => {
    for (const helpLevelUsed of [0, 1, 3]) {
      assert.deepEqual(classifyEvidence({priorFamilyAttempts: 1, helpLevelUsed}), {kind: 'not_counted', reason: 'repeat_task'})
    }
  })

  it('treats a level-0 clarifying exchange as no hint', () => {
    assert.equal(classifyEvidence({priorFamilyAttempts: 0, helpLevelUsed: 0}).kind, 'independent')
  })
})

describe('applyEvidence', () => {
  it('adds each kind to its own counter', () => {
    assert.equal(applyEvidence(EMPTY_COUNTS, 'independent', true).independentCorrect, 1)
    assert.equal(applyEvidence(EMPTY_COUNTS, 'independent', false).independentIncorrect, 1)
    assert.equal(applyEvidence(EMPTY_COUNTS, 'assisted', true).assistedCorrect, 1)
    assert.equal(applyEvidence(EMPTY_COUNTS, 'assisted', false).assistedIncorrect, 1)
  })

  it('leaves the counts unchanged for a response that does not count', () => {
    assert.deepEqual(applyEvidence(EMPTY_COUNTS, 'not_counted', true), EMPTY_COUNTS)
  })
})

describe('projectMastery', () => {
  it('keeps missing evidence unknown, not zero', () => {
    assert.deepEqual(projectMastery(EMPTY_COUNTS), {estimate: null, evidenceStatus: 'unknown'})
  })

  it('never estimates from assisted evidence alone', () => {
    const counts: MasteryCounts = {...EMPTY_COUNTS, assistedCorrect: 9}
    assert.deepEqual(projectMastery(counts), {estimate: null, evidenceStatus: 'assisted_only'})
  })

  it('uses the Beta(1,1) mean over independent evidence', () => {
    assert.deepEqual(projectMastery({...EMPTY_COUNTS, independentCorrect: 1}), {estimate: 0.6667, evidenceStatus: 'independent'})
    assert.deepEqual(projectMastery({...EMPTY_COUNTS, independentIncorrect: 1}), {estimate: 0.3333, evidenceStatus: 'independent'})
    assert.equal(projectMastery({...EMPTY_COUNTS, independentCorrect: 3, independentIncorrect: 1, assistedCorrect: 50}).estimate, 0.6667)
  })

  it('cannot be raised by repeating answers after exposure', () => {
    let counts = applyEvidence(EMPTY_COUNTS, classifyEvidence({priorFamilyAttempts: 0, helpLevelUsed: 3}).kind, true)
    for (let attempt = 1; attempt <= 5; attempt++) {
      counts = applyEvidence(counts, classifyEvidence({priorFamilyAttempts: attempt, helpLevelUsed: 3}).kind, true)
    }
    assert.deepEqual(counts, {...EMPTY_COUNTS, assistedCorrect: 1})
    assert.equal(projectMastery(counts).estimate, null)
  })
})
