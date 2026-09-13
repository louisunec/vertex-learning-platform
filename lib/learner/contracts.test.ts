import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {DatabaseUnavailableError} from '../db/errors.ts'
import {ContentUnavailableError} from './content-source.ts'
import {
  attemptResultSchema,
  helpRequestSchema,
  helpResponseSchema,
  issueTaskResponseSchema,
  MAX_BODY_BYTES,
  submitAttemptRequestSchema,
} from './contracts.ts'
import {failureResponse, readBoundedJson} from './http.ts'

const INSTANCE = '4f7f3c1e-8f55-4f53-9a4c-0d6c6a3b7e21'
const valid = {taskInstanceId: INSTANCE, optionId: 'opt-a', idempotencyKey: 'key-0123456789abcdef'}

describe('submitAttemptRequestSchema', () => {
  it('accepts a minimal submission and optional self-confidence', () => {
    assert.ok(submitAttemptRequestSchema.safeParse(valid).success)
    assert.ok(submitAttemptRequestSchema.safeParse({...valid, selfConfidence: 4}).success)
  })

  it('rejects forged identity, grade, score, and help claims', () => {
    for (const forged of [{userId: 'user_other'}, {correct: true}, {score: 1}, {hintLevel: 0}, {helpLevel: 0}, {answerExposed: false}]) {
      assert.equal(submitAttemptRequestSchema.safeParse({...valid, ...forged}).success, false, JSON.stringify(forged))
    }
  })

  it('bounds the idempotency key, instance id, and self-confidence', () => {
    for (const bad of [
      {idempotencyKey: 'short'},
      {idempotencyKey: 'x'.repeat(65)},
      {idempotencyKey: 'has spaces in the key!!'},
      {taskInstanceId: 'not-a-uuid'},
      {selfConfidence: 0},
      {selfConfidence: 6},
      {selfConfidence: 2.5},
      {optionId: ''},
    ]) {
      assert.equal(submitAttemptRequestSchema.safeParse({...valid, ...bad}).success, false, JSON.stringify(bad))
    }
  })
})

const FORBIDDEN = ['answerKey', 'correctOptionId', 'correctReason', 'distractorReasons', 'hints', 'solution']

describe('response contracts', () => {
  const item = {
    _id: 'assessment-fam-v1',
    _rev: 'r1',
    familyId: 'fam',
    version: 1,
    lessonId: 'lesson-1',
    type: 'apply',
    responseFormat: 'single_choice',
    question: 'Which?',
    options: [
      {id: 'opt-a', text: 'A'},
      {id: 'opt-b', text: 'B'},
      {id: 'opt-c', text: 'C'},
    ],
  }
  const issued = {taskInstanceId: INSTANCE, expiresAt: '2026-09-14T00:00:00.000Z', item}
  const graded = {attemptId: INSTANCE, taskInstanceId: INSTANCE, correct: true, evidence: {kind: 'independent', reasonCode: 'first_independent_response'}}

  it('accepts the learner-safe shapes', () => {
    assert.ok(issueTaskResponseSchema.safeParse(issued).success)
    assert.ok(attemptResultSchema.safeParse(graded).success)
  })

  it('rejects any response carrying an answer key, reasons, or hints', () => {
    for (const key of FORBIDDEN) {
      assert.equal(issueTaskResponseSchema.safeParse({...issued, [key]: 'x'}).success, false, key)
      assert.equal(issueTaskResponseSchema.safeParse({...issued, item: {...item, [key]: 'x'}}).success, false, key)
      assert.equal(attemptResultSchema.safeParse({...graded, [key]: 'x'}).success, false, key)
    }
  })
})

describe('helpRequestSchema', () => {
  const help = {taskInstanceId: INSTANCE, mode: 'study', request: 'hint', requestKey: 'key-0123456789abcdef'}

  it('accepts each mode and request', () => {
    for (const mode of ['study', 'reference']) {
      for (const request of ['hint', 'escalate', 'solution']) {
        assert.ok(helpRequestSchema.safeParse({...help, mode, request}).success, `${mode} ${request}`)
      }
    }
  })

  it('rejects a forged level, help history, or identity', () => {
    for (const forged of [{level: 3}, {helpLevel: 0}, {currentLevel: 2}, {hintsUsed: 0}, {userId: 'user_other'}, {learnerId: 'user_other'}]) {
      assert.equal(helpRequestSchema.safeParse({...help, ...forged}).success, false, JSON.stringify(forged))
    }
  })

  it('rejects unknown modes and requests and a malformed key or instance id', () => {
    for (const bad of [{mode: 'exam'}, {request: 'answer'}, {request: 3}, {requestKey: 'short'}, {taskInstanceId: 'nope'}]) {
      assert.equal(helpRequestSchema.safeParse({...help, ...bad}).success, false, JSON.stringify(bad))
    }
  })
})

describe('helpResponseSchema', () => {
  const body = (level: number, hint: Record<string, unknown>) => ({
    helpEventId: INSTANCE,
    level,
    reasonCode: 'escalation',
    policyVersion: 'help-v1',
    hint: {level, ...hint},
    replayed: false,
  })

  it('carries one rung, with the correct option id only at the solution level', () => {
    assert.ok(helpResponseSchema.safeParse(body(1, {text: 'Direction.'})).success)
    assert.ok(helpResponseSchema.safeParse(body(2, {text: 'Key concept.'})).success)
    assert.ok(helpResponseSchema.safeParse(body(3, {text: 'Solution.', correctOptionId: 'opt-a'})).success)
    assert.equal(helpResponseSchema.safeParse(body(1, {text: 'Direction.', correctOptionId: 'opt-a'})).success, false)
    assert.equal(helpResponseSchema.safeParse(body(2, {text: 'Key concept.', correctOptionId: 'opt-a'})).success, false)
    assert.equal(helpResponseSchema.safeParse(body(3, {text: 'Solution.'})).success, false)
  })

  it('rejects other rungs, reasons, an answer key, a level-0 hint, or a mismatched hint level', () => {
    for (const key of [...FORBIDDEN, 'direction', 'keyConcept', 'hint2']) {
      assert.equal(helpResponseSchema.safeParse({...body(1, {text: 'Direction.'}), [key]: 'x'}).success, false, key)
      assert.equal(helpResponseSchema.safeParse(body(1, {text: 'Direction.', [key]: 'x'})).success, false, `hint.${key}`)
    }
    assert.equal(helpResponseSchema.safeParse(body(0, {text: 'Clarify?'})).success, false)
    assert.equal(helpResponseSchema.safeParse({...body(2, {text: 'Key concept.'}), level: 1}).success, false)
  })
})

const post = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/attempts', {method: 'POST', body, headers, duplex: 'half'} as RequestInit)

describe('readBoundedJson', () => {
  it('parses a JSON body within the bound', async () => {
    assert.deepEqual(await readBoundedJson(post(JSON.stringify(valid))), {ok: true, value: valid})
  })

  it('rejects a declared or actual body over the bound', async () => {
    const big = JSON.stringify({pad: 'x'.repeat(MAX_BODY_BYTES)})
    assert.deepEqual(await readBoundedJson(post(big)), {ok: false, code: 'payload_too_large'})
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big))
        controller.close()
      },
    })
    assert.deepEqual(await readBoundedJson(post(stream)), {ok: false, code: 'payload_too_large'})
  })

  it('rejects malformed and missing bodies', async () => {
    assert.deepEqual(await readBoundedJson(post('{not json')), {ok: false, code: 'invalid_request'})
    assert.deepEqual(await readBoundedJson(new Request('http://localhost/api/attempts', {method: 'POST'})), {
      ok: false,
      code: 'invalid_request',
    })
  })
})

describe('failureResponse', () => {
  const quiet = <T>(run: () => T): T => {
    const original = console.error
    console.error = () => {}
    try {
      return run()
    } finally {
      console.error = original
    }
  }

  it('reports outages as retryable 503s and never as a grade', async () => {
    for (const error of [
      new DatabaseUnavailableError('DATABASE_URL is not set'),
      new ContentUnavailableError('down'),
      Object.assign(new Error('refused'), {code: 'ECONNREFUSED'}),
      Object.assign(new Error('timeout'), {code: '57014'}),
      Object.assign(new Error('closed'), {code: 'CONNECTION_CLOSED'}),
    ]) {
      const response = quiet(() => failureResponse('test', error))
      assert.equal(response.status, 503)
      assert.deepEqual(await response.json(), {error: 'Temporarily unavailable, please retry', code: 'unavailable', retryable: true})
      assert.equal(response.headers.get('cache-control'), 'no-store')
    }
  })

  it('reports anything else as a non-retryable 500', () => {
    assert.equal(quiet(() => failureResponse('test', new TypeError('bug'))).status, 500)
  })
})
