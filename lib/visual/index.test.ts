import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {toVisualSourceChunks} from '../evidence/chunks.ts'
import {DEFAULT_VISUAL_CONFIG, type VisualConfig} from './budget.ts'
import {buildVisualIndex, VISUAL_EXTRACTION_VERSION} from './index.ts'
import type {MediaSource} from './media.ts'
import type {OcrEngine} from './ocr.ts'
import {ANALYSIS_FPS, ANALYSIS_HEIGHT, ANALYSIS_WIDTH, type GrayFrame} from './sampling.ts'
import type {VlmFn} from './vlm.ts'

type Paint = (x: number, y: number) => number | undefined
type Screen = {from: number; to: number; id: string; paint: Paint; ocr: {text: string; confidence: number | null; textDensity: number}}

const stripes =
  (seed: number): Paint =>
  (x, y) =>
    y >= 32 && y < 112 && x >= 16 && x < 272 && (x + seed * (y >> 4)) % 3 === 0 ? 230 : undefined
const head =
  (dx: number): Paint =>
  (x, y) =>
    x >= 100 + dx && x < 180 + dx && y >= 40 && y < 150 ? 200 : undefined
const grid: Paint = (x, y) => (x % 4 === 0 || y % 4 === 0 ? 220 : undefined)

const text = (value: string) => ({text: value, confidence: 93, textDensity: 0.12})
const noText = {text: '', confidence: null, textDensity: 0}

function fakeMedia(screens: Screen[], durationSeconds: number): MediaSource {
  const screenAt = (t: number) => screens.find((screen) => t >= screen.from && t < screen.to) ?? screens.at(-1)!
  return {
    videoDocumentId: 'video-test-clip',
    sourceRevision: 'sha256-test',
    durationSeconds,
    width: 1280,
    height: 720,
    async sceneChangeTimes() {
      return []
    },
    async decodeAnalysisFrames(onFrame) {
      for (let i = 0; i / ANALYSIS_FPS < durationSeconds; i++) {
        const t = i / ANALYSIS_FPS
        const pixels = new Uint8Array(ANALYSIS_WIDTH * ANALYSIS_HEIGHT).fill(20)
        const paint = screenAt(t).paint
        for (let y = 0; y < ANALYSIS_HEIGHT; y++) {
          for (let x = 0; x < ANALYSIS_WIDTH; x++) pixels[y * ANALYSIS_WIDTH + x] = paint(x, y) ?? 20
        }
        const frame: GrayFrame = {timestampSeconds: t, width: ANALYSIS_WIDTH, height: ANALYSIS_HEIGHT, pixels}
        if (!onFrame(frame)) return
      }
    },
    async framePng(t) {
      return Buffer.from(screenAt(t).id)
    },
  }
}

function fakeOcr(screens: Screen[]): OcrEngine & {calls: number} {
  const engine = {
    calls: 0,
    async recognize(image: Buffer) {
      engine.calls++
      return screens.find((screen) => screen.id === image.toString())!.ocr
    },
    async terminate() {},
  }
  return engine
}

function countingVlm(): VlmFn & {calls: number} {
  const fn = Object.assign(
    async () => {
      fn.calls++
      return {status: 'described' as const, label: 'diagram' as const, text: 'A grid diagram of component state.', usage: {inputTokens: 1200, outputTokens: 60}}
    },
    {calls: 0},
  )
  return fn
}

const config = (overrides: Partial<VisualConfig['caps']> = {}): VisualConfig => ({
  ...DEFAULT_VISUAL_CONFIG,
  caps: {...DEFAULT_VISUAL_CONFIG.caps, ...overrides},
})

const codeEdit: Screen[] = [
  {from: 0, to: 5, id: 'lt', paint: stripes(1), ocr: text('function clamp(x) {\n  if (x < 10) {\n    return x\n  }\n}')},
  {from: 5, to: 10, id: 'le', paint: stripes(2), ocr: text('function clamp(x) {\n  if (x <= 10) {\n    return x\n  }\n}')},
]

const talkingHead: Screen[] = Array.from({length: 8}, (_, i) => ({
  from: i,
  to: i + 1,
  id: `head-${i}`,
  paint: head(i * 10),
  ocr: noText,
}))

describe('buildVisualIndex', () => {
  it('keeps a one-character code edit as two chunks at the edit time', async () => {
    const {document} = await buildVisualIndex({media: fakeMedia(codeEdit, 10), ocr: fakeOcr(codeEdit), transcript: [], config: config()})
    assert.deepEqual(
      document.chunks.map((chunk) => [chunk.source, chunk.startSeconds, chunk.endSeconds, chunk.text.split('\n')[1]]),
      [
        ['ocr', 0, 5, 'if (x < 10) {'],
        ['ocr', 5, 10, 'if (x <= 10) {'],
      ],
    )
    assert.equal(document._id, 'visual-video-test-clip')
    assert.equal(document.extractionVersion, VISUAL_EXTRACTION_VERSION)
    assert.equal(document.coverage.partial, false)
  })

  it('reuses OCR for identical frames', async () => {
    const ocr = fakeOcr(codeEdit)
    const {document} = await buildVisualIndex({media: fakeMedia(codeEdit, 10), ocr, transcript: [], config: config()})
    assert.equal(ocr.calls, 2)
    assert.equal(document.coverage.framesOcrd, 2)
    assert.ok(document.coverage.framesSampled > 2)
  })

  it('makes zero VLM calls for a talking head, even with a deictic transcript', async () => {
    const describe = countingVlm()
    const transcript = [{startSeconds: 0, endSeconds: 8, text: 'As you can see here, I am just talking.'}]
    const {document} = await buildVisualIndex({media: fakeMedia(talkingHead, 8), ocr: fakeOcr(talkingHead), describe, transcript, config: config()})
    assert.equal(describe.calls, 0)
    assert.equal(document.coverage.vlmCalls, 0)
    assert.deepEqual(document.chunks, [])
    assert.equal(document.coverage.partial, false)
  })

  it('calls the VLM for unread structure and stores a labelled interpretation', async () => {
    const screens: Screen[] = [
      {from: 0, to: 4, id: 'blank', paint: () => undefined, ocr: noText},
      {from: 4, to: 8, id: 'grid', paint: grid, ocr: noText},
    ]
    const describe = countingVlm()
    const {document} = await buildVisualIndex({media: fakeMedia(screens, 8), ocr: fakeOcr(screens), describe, transcript: [], config: config()})
    assert.equal(describe.calls, 1)
    const [vlm] = document.chunks
    assert.equal(vlm.source, 'vlm')
    assert.equal(vlm.vlmLabel, 'diagram')
    assert.deepEqual([vlm.startSeconds, vlm.endSeconds], [4, 6])
    assert.equal(document.coverage.estimatedCostUsd, (1200 * 0.25 + 60 * 2) / 1_000_000)
  })

  it('records a skipped span instead of calling the VLM past its cap', async () => {
    const screens: Screen[] = [
      {from: 0, to: 4, id: 'blank', paint: () => undefined, ocr: noText},
      {from: 4, to: 8, id: 'grid', paint: grid, ocr: noText},
    ]
    const describe = countingVlm()
    const {document} = await buildVisualIndex({
      media: fakeMedia(screens, 8),
      ocr: fakeOcr(screens),
      describe,
      transcript: [],
      config: config({maxVlmCalls: 0}),
    })
    assert.equal(describe.calls, 0)
    assert.equal(document.coverage.partial, true)
    assert.deepEqual(
      document.coverage.skippedSpans.map((span) => [span.reason, span.startSeconds, span.endSeconds]),
      [['vlm_cap', 4, 6]],
    )
  })

  it('records the rest of the video as skipped when the OCR cap is hit', async () => {
    const {document} = await buildVisualIndex({
      media: fakeMedia(codeEdit, 10),
      ocr: fakeOcr(codeEdit),
      transcript: [],
      config: config({maxOcrFrames: 1}),
    })
    assert.deepEqual(
      document.chunks.map((chunk) => [chunk.startSeconds, chunk.endSeconds]),
      [[0, 5]],
    )
    assert.deepEqual(
      document.coverage.skippedSpans.map((span) => [span.reason, span.startSeconds, span.endSeconds]),
      [['ocr_cap', 5, 10]],
    )
    assert.equal(document.coverage.partial, true)
  })

  it('stops sampling at the frame cap and records the remainder', async () => {
    const {document} = await buildVisualIndex({
      media: fakeMedia(codeEdit, 10),
      ocr: fakeOcr(codeEdit),
      transcript: [],
      config: config({maxFrames: 2}),
    })
    assert.equal(document.coverage.framesSampled, 2)
    assert.deepEqual(
      document.coverage.skippedSpans.map((span) => span.reason),
      ['frame_cap'],
    )
  })

  it('logs cost and coverage without extracted text', async () => {
    const {logLine} = await buildVisualIndex({media: fakeMedia(codeEdit, 10), ocr: fakeOcr(codeEdit), transcript: [], config: config()})
    assert.match(logLine, /^\[visual\] /)
    const logged = JSON.parse(logLine.slice('[visual] '.length))
    assert.equal(logged.ocrChunks, 2)
    assert.equal(logged.estimatedCostUsd, 0)
    assert.equal(typeof logged.durationMs, 'number')
    assert.ok(!logLine.includes('clamp'))
  })

  it('produces the same chunks and evidence identity on a rerun', async () => {
    const run = () => buildVisualIndex({media: fakeMedia(codeEdit, 10), ocr: fakeOcr(codeEdit), transcript: [], config: config()})
    const [first, second] = [(await run()).document, (await run()).document]
    assert.deepEqual(first.chunks, second.chunks)
    const identity = (document: typeof first) =>
      toVisualSourceChunks(document).map((chunk) => [chunk.chunkId, chunk.chunkRevision])
    assert.deepEqual(identity(first), identity(second))
    assert.equal(identity(first).length, 2)
  })
})
