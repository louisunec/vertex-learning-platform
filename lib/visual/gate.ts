/**
 * Decides whether one sampled frame justifies a vision-model (VLM) call
 * (development plan §5 PR-2). OCR always runs first; the VLM is for frames
 * that visibly carry structure OCR could not read (a diagram, code OCR
 * garbled). Framework-free and pure.
 *
 * Two preconditions must hold, or the gate stays closed:
 *   - the frame changed visually since the last kept frame, and
 *   - it has text-like structure (high-contrast edge density).
 * A talking head or other smooth footage fails the second, so it never
 * reaches the VLM however much it moves.
 *
 * Past the preconditions a weighted score must reach `threshold`:
 *   - low OCR confidence on the words that were read,
 *   - unread structure: edges present but little recognized text,
 *   - a transcript cue near that time ("as you can see here").
 * The cue's weight is below the threshold, so a deictic phrase alone is not
 * sufficient, and unread structure alone reaches it, so a cue is not
 * necessary either.
 */

export type GateSignals = {
  /** Text-region change since the previous kept frame, 0–1. */
  visualChange: number
  /** Share of high-contrast edge pixels in the downscaled frame, 0–1. */
  edgeDensity: number
  /** Mean OCR word confidence, 0–100; null when no words were read. */
  ocrConfidence: number | null
  /** Share of the frame covered by usable recognized word boxes, 0–1 (0 when OCR text was rejected). */
  textDensity: number
  /** A visual reference in the transcript near this time. */
  transcriptCue: boolean
}

export type GateConfig = {
  threshold: number
  minVisualChange: number
  minEdgeDensity: number
  /** OCR confidence at or above this adds nothing to the score. */
  confidentOcr: number
  /** Recognized text covering less of the frame than this counts as unread structure. */
  maxReadTextDensity: number
  weights: {lowConfidence: number; unreadStructure: number; transcriptCue: number}
}

export const DEFAULT_GATE_CONFIG: GateConfig = {
  threshold: 0.6,
  minVisualChange: 0.02,
  minEdgeDensity: 0.03,
  confidentOcr: 70,
  maxReadTextDensity: 0.01,
  weights: {lowConfidence: 0.6, unreadStructure: 0.6, transcriptCue: 0.3},
}

export type GateDecision = {
  call: boolean
  score: number
  reason: 'no_visual_change' | 'no_text_structure' | 'below_threshold' | 'gated'
}

export function vlmGate(signals: GateSignals, config: GateConfig = DEFAULT_GATE_CONFIG): GateDecision {
  if (signals.visualChange < config.minVisualChange) return {call: false, score: 0, reason: 'no_visual_change'}
  if (signals.edgeDensity < config.minEdgeDensity) return {call: false, score: 0, reason: 'no_text_structure'}

  const lowConfidence =
    signals.ocrConfidence === null
      ? 0
      : Math.max(0, (config.confidentOcr - signals.ocrConfidence) / config.confidentOcr)
  const unreadStructure = signals.textDensity < config.maxReadTextDensity ? 1 : 0
  const score = round(
    config.weights.lowConfidence * lowConfidence +
      config.weights.unreadStructure * unreadStructure +
      config.weights.transcriptCue * (signals.transcriptCue ? 1 : 0),
  )
  return score >= config.threshold ? {call: true, score, reason: 'gated'} : {call: false, score, reason: 'below_threshold'}
}

/** Visual references in speech. A cue only adds weight; it never opens the gate alone. */
const VISUAL_CUE =
  /\b(as you can see|you can see|take a look|look at (this|that|the)|over here|right here|on (the )?screen|shown here|this (diagram|slide|chart|graph|screen|code|example|output)|notice (how|that|the))\b/i

/** Seconds either side of a frame searched for a transcript cue. */
export const CUE_WINDOW_SECONDS = 10

/** Whether a transcript chunk overlapping the window around `timestampSeconds` has a visual cue. */
export function hasTranscriptCue(
  transcript: ReadonlyArray<{startSeconds: number; endSeconds: number; text: string}>,
  timestampSeconds: number,
  windowSeconds = CUE_WINDOW_SECONDS,
): boolean {
  return transcript.some(
    (chunk) =>
      chunk.startSeconds <= timestampSeconds + windowSeconds &&
      chunk.endSeconds >= timestampSeconds - windowSeconds &&
      VISUAL_CUE.test(chunk.text),
  )
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
