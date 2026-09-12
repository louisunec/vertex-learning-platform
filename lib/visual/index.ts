import {hashParts, visualIndexIdFor, type VisualSource} from '../evidence/chunks.ts'
import {createBudget, type Coverage, type SkipReason, type VisualConfig} from './budget.ts'
import {DEFAULT_GATE_CONFIG, hasTranscriptCue, vlmGate} from './gate.ts'
import type {MediaSource} from './media.ts'
import {mergeObservations, type OcrObservation} from './merge.ts'
import type {OcrEngine, OcrResult} from './ocr.ts'
import {createFrameSelector, type SampledFrame} from './sampling.ts'
import {VLM_MAX_OUTPUT_TOKENS, type VlmFn, type VlmLabel} from './vlm.ts'

/**
 * Builds one video's visual index (development plan §5 PR-2): sample frames,
 * OCR them, merge repeated text into appearance intervals, then call the VLM
 * only for frames the gate justifies — all within per-video caps. Anything a
 * cap or error cut short is recorded as a skipped span and marks the index
 * partial. Search reads it behind the `search-visual-evidence` flag.
 *
 * Offline tooling; never runs in the request path.
 */

/** Bump whenever sampling, the OCR engine/language, the merge rule, the gate, or the VLM prompt changes. */
export const VISUAL_EXTRACTION_VERSION = 'visual-v1'

const TRANSCRIPT_EXCERPT_SECONDS = 15

export type TranscriptWindow = ReadonlyArray<{startSeconds: number; endSeconds: number; text: string}>

export type VisualChunkDocument = {
  _key: string
  _type: 'visualChunk'
  source: VisualSource
  startSeconds: number
  endSeconds: number
  text: string
  frameRef: {timestampSeconds: number; frameHash: string}
  quality: {ocrConfidence: number | null; textDensity: number}
  vlmLabel?: VlmLabel
}

export type VideoVisualIndexDocument = {
  _id: string
  _type: 'videoVisualIndex'
  video: {_type: 'reference'; _ref: string}
  extractionVersion: string
  sourceRevision: string
  durationSeconds: number
  indexedAt: string
  chunks: VisualChunkDocument[]
  coverage: Omit<Coverage, 'skippedSpans'> & {
    skippedSpans: Array<{_key: string; _type: 'skippedSpan'; startSeconds: number; endSeconds: number; reason: SkipReason}>
  }
}

export type BuildVisualIndexInput = {
  media: MediaSource
  ocr: OcrEngine
  /** Absent or null: no VLM calls; frames the gate would send are recorded as `vlm_cap` skips. */
  describe?: VlmFn | null
  /** Transcript chunks for gate cues and short VLM excerpts; never sent whole. */
  transcript: TranscriptWindow
  config: VisualConfig
  now?: () => number
}

export type BuildVisualIndexResult = {document: VideoVisualIndexDocument; logLine: string}

export async function buildVisualIndex({
  media,
  ocr,
  describe = null,
  transcript,
  config,
  now = Date.now,
}: BuildVisualIndexInput): Promise<BuildVisualIndexResult> {
  const budget = createBudget(config, now)
  const duration = media.durationSeconds
  const gateConfig = {...DEFAULT_GATE_CONFIG, threshold: config.gateThreshold}
  const step = config.sampling.periodicSeconds

  // 1. Sampling: scene times first, then one streamed decode through the selector.
  const sceneTimes = await media.sceneChangeTimes(config.sampling.sceneThreshold)
  const selector = createFrameSelector({periodicSeconds: step, sceneTimes})
  const frames: SampledFrame[] = []
  let sampledUntil = duration
  await media.decodeAnalysisFrames((frame) => {
    const stop = budget.wallTimeExceeded() ? 'wall_time' : null
    const kept = stop ? null : selector.consider(frame)
    const refused = kept && !budget.takeFrame() ? 'frame_cap' : null
    if (stop || refused) {
      sampledUntil = frame.timestampSeconds
      budget.skip(frame.timestampSeconds, duration, (stop ?? refused) as SkipReason)
      return false
    }
    if (kept) frames.push(kept)
    return true
  })

  // 2. OCR every kept frame; an identical-looking frame reuses the previous result.
  const observations: OcrObservation[] = []
  const ocrByFrame = new Map<SampledFrame, OcrResult>()
  let coveredUntil = sampledUntil
  let previous: {frameHash: string; result: OcrResult} | null = null
  for (const [i, frame] of frames.entries()) {
    const nextTime = frames[i + 1]?.timestampSeconds ?? sampledUntil
    let result: OcrResult
    if (previous && previous.frameHash === frame.frameHash) {
      result = previous.result
    } else {
      const refused = budget.wallTimeExceeded() ? 'wall_time' : !budget.takeOcr() ? 'ocr_cap' : null
      if (refused) {
        coveredUntil = frame.timestampSeconds
        budget.skip(frame.timestampSeconds, sampledUntil, refused)
        break
      }
      try {
        result = await ocr.recognize(await media.framePng(frame.timestampSeconds), media)
      } catch {
        budget.skip(frame.timestampSeconds, nextTime, 'ocr_error')
        previous = null
        continue
      }
      ocrByFrame.set(frame, result)
    }
    previous = {frameHash: frame.frameHash, result}
    observations.push({
      timestampSeconds: frame.timestampSeconds,
      frameHash: frame.frameHash,
      text: result.text,
      confidence: result.confidence,
      textDensity: result.textDensity,
    })
  }

  const chunks: Omit<VisualChunkDocument, '_key'>[] = mergeObservations(observations, coveredUntil).map((run) => ({
    _type: 'visualChunk',
    source: 'ocr',
    startSeconds: run.startSeconds,
    endSeconds: run.endSeconds,
    text: run.text,
    frameRef: run.frame,
    quality: {ocrConfidence: run.ocrConfidence, textDensity: run.textDensity},
  }))

  // 3. VLM only where the gate justifies it, once per distinct frame, within call and spend caps.
  const described = new Set<string>()
  for (const [frame, result] of ocrByFrame) {
    const decision = vlmGate(
      {
        visualChange: frame.visualChange,
        edgeDensity: frame.edgeDensity,
        ocrConfidence: result.confidence,
        textDensity: result.textDensity,
        transcriptCue: hasTranscriptCue(transcript, frame.timestampSeconds),
      },
      gateConfig,
    )
    if (!decision.call || described.has(frame.frameHash)) continue
    described.add(frame.frameHash)
    const spanEnd = Math.min(frame.timestampSeconds + step, coveredUntil)
    const slot = budget.wallTimeExceeded() ? 'wall_time' : describe ? budget.takeVlm(VLM_MAX_OUTPUT_TOKENS) : 'vlm_cap'
    if (slot !== 'ok') {
      budget.skip(frame.timestampSeconds, spanEnd, slot)
      continue
    }
    try {
      const outcome = await describe!({
        png: await media.framePng(frame.timestampSeconds),
        timestampSeconds: frame.timestampSeconds,
        ocrText: result.text,
        transcriptExcerpt: excerptNear(transcript, frame.timestampSeconds),
      })
      budget.recordVlmUsage(outcome.usage, VLM_MAX_OUTPUT_TOKENS)
      if (outcome.status === 'invalid') budget.skip(frame.timestampSeconds, spanEnd, 'vlm_error')
      if (outcome.status !== 'described') continue
      const startSeconds = Math.floor(frame.timestampSeconds)
      chunks.push({
        _type: 'visualChunk',
        source: 'vlm',
        startSeconds,
        endSeconds: Math.max(startSeconds, Math.ceil(spanEnd)),
        text: outcome.text,
        frameRef: {timestampSeconds: frame.timestampSeconds, frameHash: frame.frameHash},
        quality: {ocrConfidence: result.confidence, textDensity: result.textDensity},
        vlmLabel: outcome.label,
      })
    } catch {
      budget.recordVlmUsage({inputTokens: null, outputTokens: null}, VLM_MAX_OUTPUT_TOKENS)
      budget.skip(frame.timestampSeconds, spanEnd, 'vlm_error')
    }
  }

  const coverage = budget.coverage()
  const document: VideoVisualIndexDocument = {
    _id: visualIndexIdFor(media.videoDocumentId),
    _type: 'videoVisualIndex',
    video: {_type: 'reference', _ref: media.videoDocumentId},
    extractionVersion: VISUAL_EXTRACTION_VERSION,
    sourceRevision: media.sourceRevision,
    durationSeconds: Math.round(duration),
    indexedAt: new Date(now()).toISOString(),
    chunks: withKeys(chunks),
    coverage: {
      ...coverage,
      skippedSpans: coverage.skippedSpans.map((span) => ({
        _key: `${span.reason}-${span.startSeconds}`,
        _type: 'skippedSpan',
        ...span,
      })),
    },
  }
  return {document, logLine: logLineFor(document)}
}

/** Deterministic keys from content (`<source>-<start>-<text hash>`), time-ordered, OCR before VLM. */
function withKeys(chunks: Omit<VisualChunkDocument, '_key'>[]): VisualChunkDocument[] {
  const seen = new Set<string>()
  return chunks
    .toSorted((a, b) => a.startSeconds - b.startSeconds || a.source.localeCompare(b.source) || a.text.localeCompare(b.text))
    .map((chunk) => {
      const base = `${chunk.source}-${chunk.startSeconds}-${hashParts([chunk.text]).slice(0, 8)}`
      let key = base
      for (let n = 1; seen.has(key); n++) key = `${base}-${n}`
      seen.add(key)
      return {_key: key, ...chunk}
    })
}

/** Transcript text within ±15 s of a frame; `buildVlmPrompt` clips it further. */
function excerptNear(transcript: TranscriptWindow, timestampSeconds: number): string {
  return transcript
    .filter(
      (chunk) =>
        chunk.startSeconds <= timestampSeconds + TRANSCRIPT_EXCERPT_SECONDS &&
        chunk.endSeconds >= timestampSeconds - TRANSCRIPT_EXCERPT_SECONDS,
    )
    .map((chunk) => chunk.text)
    .join(' ')
}

/** One line per video: cost and coverage, no extracted text. */
function logLineFor(document: VideoVisualIndexDocument): string {
  const {coverage} = document
  const reasons = [...new Set(coverage.skippedSpans.map((span) => span.reason))]
  return `[visual] ${JSON.stringify({
    video: document.video._ref,
    extractionVersion: document.extractionVersion,
    ocrChunks: document.chunks.filter((chunk) => chunk.source === 'ocr').length,
    vlmChunks: document.chunks.filter((chunk) => chunk.source === 'vlm').length,
    framesSampled: coverage.framesSampled,
    framesOcrd: coverage.framesOcrd,
    vlmCalls: coverage.vlmCalls,
    partial: coverage.partial,
    skippedSpans: coverage.skippedSpans.length,
    skipReasons: reasons,
    estimatedCostUsd: coverage.estimatedCostUsd,
    durationMs: coverage.durationMs,
  })}`
}
