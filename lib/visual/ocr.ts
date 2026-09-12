import {mkdir} from 'node:fs/promises'
import path from 'node:path'

import Tesseract from 'tesseract.js'

/**
 * OCR for sampled frames (development plan §5 PR-2) with tesseract.js (WASM,
 * no system package). The first run downloads English traineddata and caches
 * it under `node_modules/.cache/tesseract`. OCR text is untrusted data: it is
 * indexed, never followed as an instruction or executed.
 */

/** Frames below this mean word confidence, or with too few characters, yield no text. */
export const MIN_OCR_CONFIDENCE = 50
export const MIN_OCR_ALPHANUMERICS = 3

export type OcrResult = {
  /** Recognized lines; empty when the frame had no usable text. */
  text: string
  /** Mean word confidence (0–100, weighted by word length); null when no words were read. */
  confidence: number | null
  /** Share of the frame covered by usable recognized word boxes, 0–1; 0 when the text was rejected. */
  textDensity: number
}

export type OcrEngine = {
  recognize(image: Buffer, size: {width: number; height: number}): Promise<OcrResult>
  terminate(): Promise<void>
}

type PageLike = {
  blocks: Array<{
    paragraphs: Array<{lines: Array<{text: string; words: Array<{text: string; confidence: number; bbox: Bbox}>}>}>
  }> | null
}
type Bbox = {x0: number; y0: number; x1: number; y1: number}

/** Summarizes a tesseract page: line text, confidence, and word coverage. */
export function summarizeOcrPage(page: PageLike, size: {width: number; height: number}): OcrResult {
  const lines = (page.blocks ?? []).flatMap((block) => block.paragraphs.flatMap((paragraph) => paragraph.lines))
  const words = lines.flatMap((line) => line.words).filter((word) => word.text.trim().length > 0)
  if (words.length === 0) return {text: '', confidence: null, textDensity: 0}

  let weight = 0
  let weighted = 0
  let area = 0
  for (const word of words) {
    const length = word.text.trim().length
    weight += length
    weighted += word.confidence * length
    area += Math.max(0, word.bbox.x1 - word.bbox.x0) * Math.max(0, word.bbox.y1 - word.bbox.y0)
  }
  const confidence = Math.round((weighted / weight) * 10) / 10
  const textDensity = Math.round(Math.min(1, area / Math.max(1, size.width * size.height)) * 10_000) / 10_000
  const text = lines
    .map((line) => line.text.trim())
    .filter(Boolean)
    .join('\n')
  const alphanumerics = text.replace(/[^A-Za-z0-9]/g, '').length
  const usable = confidence >= MIN_OCR_CONFIDENCE && alphanumerics >= MIN_OCR_ALPHANUMERICS
  // Rejected "words" (often shapes misread as glyphs) are not read text: they
  // must not hide unread structure from the VLM gate.
  return usable ? {text, confidence, textDensity} : {text: '', confidence, textDensity: 0}
}

/** Starts one tesseract.js worker (English, LSTM engine). Call `terminate` when done. */
export async function createTesseractEngine({
  cachePath = path.join(process.cwd(), 'node_modules', '.cache', 'tesseract'),
}: {cachePath?: string} = {}): Promise<OcrEngine> {
  // tesseract.js silently skips caching when the directory is missing.
  await mkdir(cachePath, {recursive: true})
  const worker = await Tesseract.createWorker('eng', 1, {cachePath})
  // Keep the spacing between words as read (`x <= 10`); `normalizeOcrText` collapses runs later.
  await worker.setParameters({preserve_interword_spaces: '1'})
  return {
    async recognize(image, size) {
      const {data} = await worker.recognize(image, {}, {text: true, blocks: true})
      return summarizeOcrPage(data, size)
    },
    async terminate() {
      await worker.terminate()
    },
  }
}
