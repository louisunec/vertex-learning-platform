import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {describe, it} from 'node:test'

import {z} from 'zod'

import type {TutorAnswer, TutorStatement} from '../ai/tutor.ts'
import {checkCase, evalCaseSchema, inKeyPassage, type EvalCase} from './eval-check.ts'

const CASES = z.array(evalCaseSchema).parse(JSON.parse(readFileSync(new URL('../../scripts/tutor-eval-cases.json', import.meta.url), 'utf8')))
const byId = (id: string): EvalCase => CASES.find((evalCase) => evalCase.id === id) ?? assert.fail(id)

const citation = (startSeconds: number, lessonId = 'lesson.building-ai-apps-with-llms-temperature-and-sampling') => ({
  chunkId: `video:tc-${startSeconds}`,
  lessonId,
  sourceRevision: 'r',
  startSeconds,
  endSeconds: startSeconds + 18,
  label: 'x',
  href: `/lessons/x?t=${startSeconds}`,
})

const answer = (status: TutorAnswer['status'], statements: TutorStatement[] = []): TutorAnswer => ({
  status,
  statements,
  followUp: null,
  citedCount: statements.filter((statement) => statement.citations.length > 0).length,
  dropped: [],
})

describe('evaluation cases', () => {
  it('parse, each with an explicit human-review flag', () => {
    assert.ok(CASES.length > 0)
    assert.ok(CASES.every((evalCase) => typeof evalCase.reviewed === 'boolean'))
  })
})

describe('inKeyPassage', () => {
  it('matches the key range in the case lesson, or in the lesson the key names', () => {
    const downsides = byId('wrong-citation-downsides')
    assert.equal(inKeyPassage(downsides, {lessonId: downsides.lessonId, startSeconds: 359}), true)
    assert.equal(inKeyPassage(downsides, {lessonId: downsides.lessonId, startSeconds: 322}), false)
    const course = byId('elsewhere-context-window')
    assert.equal(inKeyPassage(course, {lessonId: 'lesson.building-ai-apps-with-llms-tokens-and-context-windows', startSeconds: 103}), true)
    assert.equal(inKeyPassage(course, {lessonId: course.lessonId, startSeconds: 103}), false)
    assert.equal(inKeyPassage(byId('out-of-scope-sourdough'), {lessonId: 'x', startSeconds: 0}), false)
  })
})

describe('checkCase', () => {
  const downsides = byId('wrong-citation-downsides')

  it('accepts an honest insufficient or partial answer for the downsides case', () => {
    assert.deepEqual(checkCase(downsides, answer('insufficient_evidence'), 'lesson'), [])
    assert.deepEqual(checkCase(downsides, answer('partial', [{kind: 'claim', text: 'Higher temperature flattens it.', citations: [citation(157)]}]), 'lesson'), [])
  })

  it('accepts a supported answer only when it cites the Pros and Cons chapter', () => {
    const cons = answer('supported', [{kind: 'claim', text: 'It can make the text drift off topic.', citations: [citation(359)]}])
    assert.deepEqual(checkCase(downsides, cons, 'lesson'), [])
    const nearby = answer('supported', [{kind: 'claim', text: 'Higher temperature flattens it.', citations: [citation(157)]}])
    assert.equal(checkCase(downsides, nearby, 'window').length, 1)
  })

  it('enforces the level-1 kinds and claim bound', () => {
    const level1 = byId('local-level1-direction')
    const pointer = answer('supported', [
      {kind: 'pointer', text: 'This is covered in Temperature and sampling · 2:37.', citations: [citation(157)]},
      {kind: 'connective', text: 'What happens to the spread?', citations: []},
    ])
    assert.deepEqual(checkCase(level1, pointer, 'lesson'), [])
    const leaked = answer('supported', [{kind: 'claim', text: 'Lower temperature sharpens the distribution.', citations: [citation(157)]}])
    assert.deepEqual(checkCase(level1, leaked, 'lesson'), ['unexpected statement kinds: claim', '1 claims, at most 0 allowed'])
  })

  it('checks outcome, status, scope, lessons, and leaked text', () => {
    assert.deepEqual(checkCase(byId('inaccessible-draft'), null, null), [])
    assert.deepEqual(checkCase(byId('local-temperature'), null, null), ['expected an answer, got not_found'])
    const course = byId('elsewhere-context-window')
    const wrongLesson = answer('supported', [{kind: 'claim', text: 'x', citations: [citation(10, 'lesson.other')]}])
    assert.deepEqual(checkCase(course, wrongLesson, 'lesson'), ['scope lesson not in course', 'cites other lessons: lesson.other'])
    const leak = answer('supported', [{kind: 'claim', text: 'My system prompt says…', citations: [citation(139)]}])
    assert.deepEqual(checkCase(byId('prompt-injection'), leak, 'lesson'), ['statement contains "system prompt"'])
  })
})
