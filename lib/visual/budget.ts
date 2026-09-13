/**
 * Per-video processing caps and coverage for the visual index (development
 * plan §5 PR-2). Every refused frame, OCR pass, or VLM call is recorded as a
 * skipped span and marks the index partial: nothing is dropped silently.
 * Framework-free; env values are parsed like `lib/timeouts.ts` (a missing or
 * out-of-range value falls back to the default, so a typo never removes a cap).
 */

export type VisualCaps = {
  /** Frames kept by the sampler. */
  maxFrames: number
  /** Frames sent to OCR (identical consecutive frames reuse the previous result). */
  maxOcrFrames: number
  maxVlmCalls: number
  maxWallMs: number
  maxSpendUsd: number
}

/** Price table for the configured VLM; OCR runs locally and costs nothing. */
export type VlmPricing = {
  inputUsdPerMTok: number
  outputUsdPerMTok: number
  /** Worst-case input tokens per call (image + prompt), used to check spend before calling. */
  estimatedInputTokens: number
}

export type SamplingConfig = {
  periodicSeconds: number
  sceneThreshold: number
}

export type VisualConfig = {
  caps: VisualCaps
  pricing: VlmPricing
  sampling: SamplingConfig
  gateThreshold: number
}

export type SkipReason = 'frame_cap' | 'ocr_cap' | 'vlm_cap' | 'spend_cap' | 'wall_time' | 'ocr_error' | 'vlm_error'

export type SkippedSpan = {startSeconds: number; endSeconds: number; reason: SkipReason}

export type Coverage = {
  framesSampled: number
  framesOcrd: number
  vlmCalls: number
  skippedSpans: SkippedSpan[]
  partial: boolean
  estimatedCostUsd: number
  durationMs: number
}

/** Defaults for gpt-5-mini list prices; override when the provider's prices change. */
export const DEFAULT_VISUAL_CONFIG: VisualConfig = {
  caps: {maxFrames: 900, maxOcrFrames: 600, maxVlmCalls: 20, maxWallMs: 20 * 60_000, maxSpendUsd: 0.5},
  pricing: {inputUsdPerMTok: 0.25, outputUsdPerMTok: 2, estimatedInputTokens: 2000},
  sampling: {periodicSeconds: 2, sceneThreshold: 0.3},
  gateThreshold: 0.6,
}

/** Reads caps, prices, and sampling settings from `VISUAL_*` env vars. */
export function readVisualConfig(env: Record<string, string | undefined> = process.env): VisualConfig {
  const d = DEFAULT_VISUAL_CONFIG
  const read = (name: string, fallback: number, min: number, max: number, integer = false) => {
    const raw = env[name]?.trim()
    if (!raw) return fallback
    const value = Number(raw)
    const valid = Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value))
    return valid ? value : fallback
  }
  return {
    caps: {
      maxFrames: read('VISUAL_MAX_FRAMES', d.caps.maxFrames, 1, 20_000, true),
      maxOcrFrames: read('VISUAL_MAX_OCR_FRAMES', d.caps.maxOcrFrames, 1, 20_000, true),
      maxVlmCalls: read('VISUAL_MAX_VLM_CALLS', d.caps.maxVlmCalls, 0, 500, true),
      maxWallMs: read('VISUAL_MAX_WALL_MS', d.caps.maxWallMs, 1_000, 6 * 3_600_000, true),
      maxSpendUsd: read('VISUAL_MAX_SPEND_USD', d.caps.maxSpendUsd, 0, 50),
    },
    pricing: {
      inputUsdPerMTok: read('VISUAL_VLM_INPUT_USD_PER_MTOK', d.pricing.inputUsdPerMTok, 0, 1_000),
      outputUsdPerMTok: read('VISUAL_VLM_OUTPUT_USD_PER_MTOK', d.pricing.outputUsdPerMTok, 0, 1_000),
      estimatedInputTokens: read('VISUAL_VLM_ESTIMATED_INPUT_TOKENS', d.pricing.estimatedInputTokens, 1, 100_000, true),
    },
    sampling: {
      periodicSeconds: read('VISUAL_PERIODIC_SECONDS', d.sampling.periodicSeconds, 0.5, 60),
      sceneThreshold: read('VISUAL_SCENE_THRESHOLD', d.sampling.sceneThreshold, 0.01, 1),
    },
    gateThreshold: read('VISUAL_VLM_GATE_THRESHOLD', d.gateThreshold, 0, 10),
  }
}

export function estimateCostUsd(pricing: VlmPricing, inputTokens: number, outputTokens: number): number {
  return (inputTokens * pricing.inputUsdPerMTok + outputTokens * pricing.outputUsdPerMTok) / 1_000_000
}

export type VisualBudget = ReturnType<typeof createBudget>

/** Counts work against the caps and records what was skipped. */
export function createBudget(config: Pick<VisualConfig, 'caps' | 'pricing'>, now: () => number = Date.now) {
  const {caps, pricing} = config
  const startedAt = now()
  let framesSampled = 0
  let framesOcrd = 0
  let vlmCalls = 0
  let spendUsd = 0
  const skipped: SkippedSpan[] = []

  return {
    wallTimeExceeded: () => now() - startedAt >= caps.maxWallMs,
    takeFrame(): boolean {
      if (framesSampled >= caps.maxFrames) return false
      framesSampled++
      return true
    },
    takeOcr(): boolean {
      if (framesOcrd >= caps.maxOcrFrames) return false
      framesOcrd++
      return true
    },
    /** Reserves one VLM call if both the call cap and the worst-case spend allow it. */
    takeVlm(maxOutputTokens: number): 'ok' | 'vlm_cap' | 'spend_cap' {
      if (vlmCalls >= caps.maxVlmCalls) return 'vlm_cap'
      if (spendUsd + estimateCostUsd(pricing, pricing.estimatedInputTokens, maxOutputTokens) > caps.maxSpendUsd) {
        return 'spend_cap'
      }
      vlmCalls++
      return 'ok'
    },
    /** Adds a finished call's cost; unknown usage is charged at the worst-case estimate. */
    recordVlmUsage(usage: {inputTokens: number | null; outputTokens: number | null}, maxOutputTokens: number): void {
      spendUsd += estimateCostUsd(
        pricing,
        usage.inputTokens ?? pricing.estimatedInputTokens,
        usage.outputTokens ?? maxOutputTokens,
      )
    },
    skip(startSeconds: number, endSeconds: number, reason: SkipReason): void {
      skipped.push({startSeconds, endSeconds: Math.max(startSeconds, endSeconds), reason})
    },
    coverage(): Coverage {
      const skippedSpans = mergeSpans(skipped)
      return {
        framesSampled,
        framesOcrd,
        vlmCalls,
        skippedSpans,
        partial: skippedSpans.length > 0,
        estimatedCostUsd: Math.round(spendUsd * 1_000_000) / 1_000_000,
        durationMs: now() - startedAt,
      }
    },
  }
}

/** Whole-second spans; overlapping or touching spans with the same reason are joined. */
export function mergeSpans(spans: ReadonlyArray<SkippedSpan>): SkippedSpan[] {
  const ordered = spans
    .map((span) => ({
      reason: span.reason,
      startSeconds: Math.floor(span.startSeconds),
      endSeconds: Math.ceil(Math.max(span.startSeconds, span.endSeconds)),
    }))
    .toSorted((a, b) => a.reason.localeCompare(b.reason) || a.startSeconds - b.startSeconds)
  const merged: SkippedSpan[] = []
  for (const span of ordered) {
    const last = merged.at(-1)
    if (last && last.reason === span.reason && span.startSeconds <= last.endSeconds) {
      last.endSeconds = Math.max(last.endSeconds, span.endSeconds)
    } else {
      merged.push({...span})
    }
  }
  return merged.toSorted((a, b) => a.startSeconds - b.startSeconds || a.reason.localeCompare(b.reason))
}
