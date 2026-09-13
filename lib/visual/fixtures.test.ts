import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {after, before, describe, it} from 'node:test'

import {findChrome, makeVisualFixtures, type FixtureName} from '../../scripts/fixtures/make-visual-fixtures.mts'
import {DEFAULT_VISUAL_CONFIG, type VisualConfig} from './budget.ts'
import {buildVisualIndex} from './index.ts'
import {hasMediaTools, openLocalMedia} from './media.ts'
import {createTesseractEngine, type OcrEngine} from './ocr.ts'
import type {VlmFn} from './vlm.ts'

/**
 * PR-2 acceptance on synthetic fixtures (development plan §5 PR-2): real
 * ffmpeg sampling and tesseract.js OCR, with a counting VLM stub. Skips when
 * ffmpeg/ffprobe or Chrome is unavailable. The first run downloads English
 * traineddata for OCR.
 */

const missing = [(await hasMediaTools()) ? null : 'ffmpeg/ffprobe (PATH or FFMPEG_PATH/FFPROBE_PATH)', findChrome() ? null : 'Chrome (CHROME_PATH)']
  .filter(Boolean)
  .join(' and ')
const skip = missing ? `visual fixture integration needs ${missing}` : false

describe('visual index on synthetic fixtures', {skip, timeout: 240_000}, () => {
  let dir = ''
  let fixtures: Record<FixtureName, string>
  let ocr: OcrEngine

  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vertex-visual-fixtures-'))
    ;[fixtures, ocr] = await Promise.all([makeVisualFixtures(dir), createTesseractEngine()])
  })

  after(async () => {
    await ocr?.terminate()
    if (dir) await rm(dir, {recursive: true, force: true})
  })

  /** Counts calls and records the frame times; describes every gated frame as a diagram. */
  const countingVlm = (): VlmFn & {calls: number; times: number[]} =>
    Object.assign(
      async ({timestampSeconds}: {timestampSeconds: number}) => {
        stub.calls++
        stub.times.push(timestampSeconds)
        return {status: 'described' as const, label: 'diagram' as const, text: 'stub description', usage: {inputTokens: null, outputTokens: null}}
      },
      {calls: 0, times: [] as number[]},
    )
  let stub = countingVlm()

  async function index(name: FixtureName, config: VisualConfig = DEFAULT_VISUAL_CONFIG) {
    stub = countingVlm()
    const media = await openLocalMedia({file: fixtures[name], videoDocumentId: `video-fixture-${name}`})
    const result = await buildVisualIndex({media, ocr, describe: stub, transcript: [], config})
    console.log(result.logLine)
    return {...result, vlmCalls: stub.calls, vlmTimes: stub.times}
  }

  const firstWith = <T extends {text: string}>(chunks: T[], needle: string): T | undefined =>
    chunks.find((chunk) => chunk.text.includes(needle))

  it('silent typing: identifiers are retrievable at the times they are on screen', async () => {
    const {document} = await index('silent-typing')
    const signature = firstWith(document.chunks, 'calculateTotal(items)')
    assert.equal(signature?.startSeconds, 0)
    const price = firstWith(document.chunks, 'item.price')
    assert.ok(price && price.startSeconds >= 4 && price.startSeconds <= 5, `item.price first at ${price?.startSeconds}`)
    const complete = firstWith(document.chunks, 'return total')
    assert.ok(complete && complete.startSeconds >= 8 && complete.startSeconds <= 9, `return total first at ${complete?.startSeconds}`)
    assert.equal(complete.endSeconds, 12)
    assert.ok(document.chunks.every((chunk) => chunk.source === 'ocr' && chunk.endSeconds <= 12))
  })

  it('code edit: the one-character change survives merging', async () => {
    const {document} = await index('code-edit')
    const before = firstWith(document.chunks, 'x < 10')
    const after = firstWith(document.chunks, 'x <= 10')
    assert.ok(before && after, `chunks: ${JSON.stringify(document.chunks.map((chunk) => chunk.text))}`)
    assert.deepEqual([before.startSeconds, Math.abs(before.endSeconds - 5) <= 1], [0, true])
    assert.ok(Math.abs(after.startSeconds - 5) <= 1)
    assert.equal(after.endSeconds, 10)
    assert.notEqual(before, after)
  })

  it('slide change: each slide is indexed from when it appears', async () => {
    const {document} = await index('slide-change')
    for (const [title, start] of [
      ['Introduction to React Hooks', 0],
      ['useEffect Cleanup', 3],
      ['Custom Hooks', 6],
    ] as const) {
      const chunk = firstWith(document.chunks, title)
      assert.ok(chunk && Math.abs(chunk.startSeconds - start) <= 1, `${title} first at ${chunk?.startSeconds}`)
    }
  })

  it('visual diagram: the default gate sends unlabelled diagrams to the VLM, and OCR keeps the unspoken identifier', async () => {
    const {document, vlmCalls, vlmTimes} = await index('visual-diagram')
    assert.equal(vlmCalls, 2, `VLM frames: ${JSON.stringify(vlmTimes)}`)
    assert.ok(vlmTimes.some((t) => t >= 4 && t < 8) && vlmTimes.some((t) => t >= 8 && t < 12), JSON.stringify(vlmTimes))
    const vlm = document.chunks.filter((chunk) => chunk.source === 'vlm')
    assert.deepEqual(
      vlm.map((chunk) => chunk.vlmLabel),
      ['diagram', 'diagram'],
    )
    const identifier = firstWith(document.chunks, 'selectVisibleTodos')
    assert.equal(identifier?.source, 'ocr')
    assert.deepEqual([identifier?.startSeconds, identifier?.endSeconds], [0, 4])
  })

  it('talking head: zero VLM calls and no visual chunks', async () => {
    const {document, vlmCalls} = await index('talking-head')
    assert.equal(vlmCalls, 0)
    assert.equal(document.coverage.vlmCalls, 0)
    assert.deepEqual(document.chunks, [])
  })

  it('caps: an OCR cap records a skipped span and marks the index partial', async () => {
    const {document, logLine} = await index('silent-typing', {
      ...DEFAULT_VISUAL_CONFIG,
      caps: {...DEFAULT_VISUAL_CONFIG.caps, maxOcrFrames: 2},
    })
    assert.equal(document.coverage.framesOcrd, 2)
    assert.equal(document.coverage.partial, true)
    const [span] = document.coverage.skippedSpans
    assert.equal(span.reason, 'ocr_cap')
    assert.equal(span.endSeconds, 12)
    assert.match(logLine, /"partial":true/)
    assert.match(logLine, /"estimatedCostUsd":0/)
  })
})
