import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {APICallError} from 'ai'
import {MockLanguageModelV4} from 'ai/test'
import {z} from 'zod'

import {AiCallError, generateBoundedObject, type AiCallDiagnostics} from './gateway.ts'

const schema = z.object({keywords: z.array(z.string()).max(3)})
const versions = {task: 'test-task', promptVersion: 'v1'}
const PROMPT = 'Learner query: "secret learner text"'

const usage = {
  inputTokens: {total: 12, noCache: 12, cacheRead: undefined, cacheWrite: undefined},
  outputTokens: {total: 5, text: 5, reasoning: undefined},
}

function textModel(text: string) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{type: 'text', text}],
      finishReason: {unified: 'stop', raw: undefined},
      usage,
      warnings: [],
    }),
  })
}

async function call(model: MockLanguageModelV4, timeoutMs?: number) {
  const logs: AiCallDiagnostics[] = []
  const promise = generateBoundedObject({
    model,
    schema,
    system: 'system',
    prompt: PROMPT,
    maxOutputTokens: 100,
    timeoutMs,
    versions,
    log: (diagnostics) => logs.push(diagnostics),
  })
  return {promise, logs}
}

describe('generateBoundedObject', () => {
  it('returns schema-validated output and logs usage', async () => {
    const {promise, logs} = await call(textModel('{"keywords":["hooks","state"]}'))
    assert.deepEqual(await promise, {keywords: ['hooks', 'state']})
    assert.equal(logs.length, 1)
    assert.equal(logs[0].status, 'ok')
    assert.equal(logs[0].task, 'test-task')
    assert.equal(logs[0].inputTokens, 12)
    assert.equal(logs[0].outputTokens, 5)
  })

  it('classifies output that fails the schema as invalid_output', async () => {
    const {promise, logs} = await call(textModel('{"keywords":["a","b","c","d"]}'))
    await assert.rejects(promise, (error) => error instanceof AiCallError && error.category === 'invalid_output')
    assert.equal(logs[0].status, 'invalid_output')
  })

  it('classifies non-JSON output as invalid_output', async () => {
    const {promise} = await call(textModel('Sure! Here are some keywords: hooks'))
    await assert.rejects(promise, (error) => error instanceof AiCallError && error.category === 'invalid_output')
  })

  it('retries a transient provider error at most once, then reports provider_error', async () => {
    let calls = 0
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        calls++
        throw new APICallError({message: 'unavailable', url: 'https://provider.test', requestBodyValues: {}, statusCode: 503, isRetryable: true})
      },
    })
    const {promise, logs} = await call(model)
    await assert.rejects(promise, (error) => error instanceof AiCallError && error.category === 'provider_error')
    assert.equal(calls, 2)
    assert.equal(logs[0].status, 'provider_error')
  })

  it('aborts a stalled call as timeout', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: ({abortSignal}) =>
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error('not aborted')), 2_000)
          abortSignal?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(abortSignal.reason)
          })
        }),
    })
    const {promise, logs} = await call(model, 20)
    await assert.rejects(promise, (error) => error instanceof AiCallError && error.category === 'timeout')
    assert.equal(logs[0].status, 'timeout')
  })

  it('passes provider options and the output budget through to the model', async () => {
    let received: {providerOptions?: unknown; maxOutputTokens?: number} = {}
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        received = options
        return {
          content: [{type: 'text', text: '{"keywords":["hooks"]}'}],
          finishReason: {unified: 'stop', raw: undefined},
          usage,
          warnings: [],
        }
      },
    })
    await generateBoundedObject({
      model,
      schema,
      system: 'system',
      prompt: PROMPT,
      maxOutputTokens: 96,
      providerOptions: {openai: {reasoningEffort: 'minimal', reasoningSummary: null}},
      versions,
      log: () => {},
    })
    assert.deepEqual(received.providerOptions, {openai: {reasoningEffort: 'minimal', reasoningSummary: null}})
    assert.equal(received.maxOutputTokens, 96)
  })

  it('never puts prompt or output text in diagnostics', async () => {
    const {promise, logs} = await call(textModel('{"keywords":["unique-output-token"]}'))
    await promise
    const serialized = JSON.stringify(logs)
    assert.ok(!serialized.includes('secret learner text'))
    assert.ok(!serialized.includes('unique-output-token'))
  })
})
