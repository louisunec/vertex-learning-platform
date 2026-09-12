import {createHash} from 'node:crypto'

/**
 * Frame sampling for the visual index (development plan §5 PR-2). Frames are
 * decoded once at `ANALYSIS_FPS` as small greyscale images; a frame is kept
 * when any of three signals fires:
 *   - periodic: at least `periodicSeconds` since the last periodic frame,
 *   - scene: an ffmpeg scene score above the threshold landed since the
 *     previous analysis frame (a starting point only: code edits and slide
 *     builds often stay under it),
 *   - text-region change: a high-contrast, text-like block changed since the
 *     last kept frame, which catches a one-character code edit.
 * Framework-free; ffmpeg decoding lives in `media.ts`.
 */

export const ANALYSIS_FPS = 2
export const ANALYSIS_WIDTH = 320
export const ANALYSIS_HEIGHT = 180

/** Grey-level step between neighbours that counts as an edge pixel. */
const EDGE_STEP = 40
const BLOCK_SIZE = 16
/** Share of edge pixels that makes a block text-like (straight shape outlines stay below it). */
const TEXT_BLOCK_EDGE_SHARE = 0.15
/** Mean absolute grey difference that marks a block as changed (compression noise stays below it). */
const CHANGED_BLOCK_MEAN_DIFF = 6
/** Changed blocks without text-like structure count this much toward visual change. */
const PLAIN_BLOCK_WEIGHT = 0.25

/** One decoded analysis frame: `width × height` 8-bit grey pixels. */
export type GrayFrame = {
  timestampSeconds: number
  width: number
  height: number
  pixels: Uint8Array
}

export type FrameSignals = {periodic: boolean; scene: boolean; textChange: boolean}

/** A kept frame and the measurements the OCR merge and VLM gate need. */
export type SampledFrame = {
  timestampSeconds: number
  frameHash: string
  edgeDensity: number
  /** Weighted share of blocks changed since the last kept frame (text-like blocks weigh most). */
  visualChange: number
  signals: FrameSignals
}

/** Share of pixels with a strong horizontal or vertical grey-level step. */
export function edgeDensity(frame: GrayFrame): number {
  return countEdges(frame, 0, 0, frame.width, frame.height) / (frame.width * frame.height)
}

/** Stable hash of a frame's coarse grey levels: identical-looking frames share it. */
export function frameHash(frame: GrayFrame): string {
  const coarse = Uint8Array.from(frame.pixels, (value) => value >> 4)
  return createHash('sha256').update(coarse).digest('hex').slice(0, 16)
}

/**
 * Block-level change between two frames of the same size. `text` is the
 * share of all blocks that are text-like and changed; `weighted` also counts
 * plain changed blocks at `PLAIN_BLOCK_WEIGHT`.
 */
export function blockChange(previous: GrayFrame, current: GrayFrame): {text: number; weighted: number} {
  const columns = Math.floor(current.width / BLOCK_SIZE)
  const rows = Math.floor(current.height / BLOCK_SIZE)
  const blockPixels = BLOCK_SIZE * BLOCK_SIZE
  let textChanged = 0
  let plainChanged = 0
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const x0 = column * BLOCK_SIZE
      const y0 = row * BLOCK_SIZE
      let diff = 0
      for (let y = y0; y < y0 + BLOCK_SIZE; y++) {
        for (let x = x0; x < x0 + BLOCK_SIZE; x++) {
          const i = y * current.width + x
          diff += Math.abs(current.pixels[i] - previous.pixels[i])
        }
      }
      if (diff / blockPixels < CHANGED_BLOCK_MEAN_DIFF) continue
      const textLike =
        countEdges(current, x0, y0, BLOCK_SIZE, BLOCK_SIZE) / blockPixels >= TEXT_BLOCK_EDGE_SHARE ||
        countEdges(previous, x0, y0, BLOCK_SIZE, BLOCK_SIZE) / blockPixels >= TEXT_BLOCK_EDGE_SHARE
      if (textLike) textChanged++
      else plainChanged++
    }
  }
  const blocks = Math.max(1, columns * rows)
  return {text: textChanged / blocks, weighted: (textChanged + PLAIN_BLOCK_WEIGHT * plainChanged) / blocks}
}

/**
 * Streams analysis frames through the three signals. `sceneTimes` are the
 * sorted timestamps where ffmpeg's scene score passed its threshold.
 * `consider` returns the kept frame, or null when no signal fired.
 */
export function createFrameSelector({
  periodicSeconds,
  sceneTimes,
  fps = ANALYSIS_FPS,
}: {
  periodicSeconds: number
  sceneTimes: ReadonlyArray<number>
  fps?: number
}) {
  const halfStep = 0.5 / fps
  let sceneIndex = 0
  let lastPeriodic = Number.NEGATIVE_INFINITY
  let lastKept: GrayFrame | null = null

  return {
    consider(frame: GrayFrame): SampledFrame | null {
      const periodic = frame.timestampSeconds - lastPeriodic >= periodicSeconds - halfStep
      let scene = false
      while (sceneIndex < sceneTimes.length && sceneTimes[sceneIndex] <= frame.timestampSeconds + halfStep) {
        scene = true
        sceneIndex++
      }
      const change = lastKept ? blockChange(lastKept, frame) : {text: 1, weighted: 1}
      const textChange = change.text > 0
      if (!periodic && !scene && !textChange) return null
      if (periodic) lastPeriodic = frame.timestampSeconds
      lastKept = frame
      return {
        timestampSeconds: frame.timestampSeconds,
        frameHash: frameHash(frame),
        edgeDensity: round(edgeDensity(frame)),
        visualChange: round(change.weighted),
        signals: {periodic, scene, textChange},
      }
    },
  }
}

function countEdges(frame: GrayFrame, x0: number, y0: number, width: number, height: number): number {
  const {pixels, width: stride} = frame
  const xEnd = Math.min(x0 + width, frame.width - 1)
  const yEnd = Math.min(y0 + height, frame.height - 1)
  let edges = 0
  for (let y = y0; y < yEnd; y++) {
    for (let x = x0; x < xEnd; x++) {
      const i = y * stride + x
      if (Math.abs(pixels[i + 1] - pixels[i]) >= EDGE_STEP || Math.abs(pixels[i + stride] - pixels[i]) >= EDGE_STEP) edges++
    }
  }
  return edges
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000
}
