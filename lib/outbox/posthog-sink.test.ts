import assert from 'node:assert/strict'
import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http'
import type {AddressInfo} from 'node:net'
import {after, before, describe, it} from 'node:test'

import {createPostHogSink, SinkError} from './posthog-sink.ts'
import type {CaptureEvent} from './projection.ts'

/** The batch sink against an in-process HTTP server: never the real PostHog project. */

const EVENT: CaptureEvent = {
  event: 'attempt_graded',
  distinct_id: 'user_a',
  properties: {correct: true, source: 'learner_outbox'},
  uuid: '0b8f7e0c-6a2f-4c51-9c47-3f1c2d9e8a10',
  timestamp: '2026-09-14T01:02:03.456Z',
}

describe('createPostHogSink', () => {
  let server: Server
  let host: string
  let respond: (request: IncomingMessage, response: ServerResponse, body: string) => void = () => {}
  const bodies: Array<{url: string; body: unknown}> = []

  before(async () => {
    server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        bodies.push({url: request.url ?? '', body: body ? JSON.parse(body) : null})
        respond(request, response, body)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    host = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  })
  after(() => new Promise<void>((resolve) => server.close(() => resolve())))

  it('posts the batch with the project token and resolves on 2xx', async () => {
    respond = (_request, response) => response.writeHead(200, {'content-type': 'application/json'}).end('{"status":1}')
    bodies.length = 0
    await createPostHogSink({host, projectToken: 'phc_test'}).send([EVENT])
    assert.equal(bodies.length, 1)
    assert.equal(bodies[0].url, '/batch/')
    assert.deepEqual(bodies[0].body, {api_key: 'phc_test', batch: [EVENT]})
  })

  it('sends nothing for an empty batch', async () => {
    bodies.length = 0
    await createPostHogSink({host, projectToken: 'phc_test'}).send([])
    assert.equal(bodies.length, 0)
  })

  it('categorizes rejections so the dispatcher can back off', async () => {
    for (const [status, category] of [
      [500, 'http_5xx'],
      [503, 'http_5xx'],
      [429, 'rate_limited'],
      [401, 'auth'],
      [403, 'auth'],
      [413, 'payload_too_large'],
      [400, 'http_4xx'],
    ] as const) {
      respond = (_request, response) => response.writeHead(status).end('no')
      await assert.rejects(
        createPostHogSink({host, projectToken: 'phc_test'}).send([EVENT]),
        (error: unknown) => error instanceof SinkError && error.category === category && error.status === status,
        String(status),
      )
    }
  })

  it('treats a slow endpoint as a timeout and an unreachable one as a network error', async () => {
    respond = (_request, response) => setTimeout(() => response.writeHead(200).end('{}'), 500)
    await assert.rejects(
      createPostHogSink({host, projectToken: 'phc_test', timeoutMs: 50}).send([EVENT]),
      (error: unknown) => error instanceof SinkError && error.category === 'timeout',
    )
    await assert.rejects(
      createPostHogSink({host: 'http://127.0.0.1:1', projectToken: 'phc_test'}).send([EVENT]),
      (error: unknown) => error instanceof SinkError && error.category === 'network',
    )
  })
})
