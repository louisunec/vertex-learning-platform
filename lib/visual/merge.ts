/**
 * Merges consecutive OCR observations of sampled frames into visual chunks
 * with appearance intervals (development plan §5 PR-2). Framework-free.
 *
 * Two consecutive observations merge only when their text is equal after
 * whitespace normalization, or at least `MERGE_SIMILARITY` similar with every
 * changed token explained as OCR noise: changed tokens must pair one-to-one
 * with a close spelling variant (at most `MAX_NOISE_EDITS` edits, both at
 * least `MIN_NOISE_TOKEN_LENGTH` characters), and neither side may be
 * material. A token is material when it contains an operator or punctuation
 * character, a digit, `_` or `$`, or a camelCase boundary, or when it sits on
 * a code-like line (one containing an operator or bracket). So OCR noise in
 * slide prose ("Introducton" / "Introduction") merges, while `x < 10` →
 * `x <= 10`, `count` → `total` on `let count = 0`, `item.price` →
 * `item.prices`, "Slide A" → "Slide B", or an inserted "not" always survive
 * as separate chunks. Keeping a spurious duplicate is cheap; erasing a real
 * change is not.
 *
 * Merging never crosses a differing observation: text A, then B, then A
 * again yields three chunks, each with its own interval.
 */

export const MERGE_SIMILARITY = 0.9
export const MAX_NOISE_EDITS = 2
export const MIN_NOISE_TOKEN_LENGTH = 4
/** Stored text per chunk is clipped at a line boundary to bound document size. */
export const MAX_VISUAL_TEXT_LENGTH = 4000

/** Text read from one sampled frame. `text` is empty when the frame had no usable text. */
export type OcrObservation = {
  timestampSeconds: number
  frameHash: string
  text: string
  /** Mean word confidence, 0–100; null when no words were read. */
  confidence: number | null
  /** Share of the frame covered by recognized word boxes, 0–1. */
  textDensity: number
}

/** One run of equivalent text, ready to become an `ocr` chunk. */
export type MergedText = {
  text: string
  startSeconds: number
  endSeconds: number
  /** The observation whose text was kept: highest confidence, earliest on a tie. */
  frame: {timestampSeconds: number; frameHash: string}
  ocrConfidence: number | null
  textDensity: number
}

const OPERATOR_CHARS = /[<>=!+\-*/%&|^~?:;,.()[\]{}"'`\\@#]/
const CODE_LINE = /[<>=+*/%&|^~;()[\]{}]/
const IDENTIFIER_MARKS = /[0-9_$]|[a-z][A-Z]/

/** Trims each line, collapses runs of spaces/tabs, and drops empty lines. */
export function normalizeOcrText(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((line) => line.length > 0)
  const kept: string[] = []
  let length = 0
  for (const line of lines) {
    if (length + line.length > MAX_VISUAL_TEXT_LENGTH) break
    kept.push(line)
    length += line.length + 1
  }
  return kept.join('\n')
}

/** Whether two observed texts are the same on-screen content. */
export function isSameText(a: string, b: string): boolean {
  const keyA = comparisonKey(a)
  const keyB = comparisonKey(b)
  if (keyA === keyB) return true
  if (similarity(keyA, keyB) < MERGE_SIMILARITY) return false
  return changedHunks(tokens(a), tokens(b)).every(
    ({removed, added}) => removed.length === added.length && removed.every((token, i) => isNoisePair(token, added[i])),
  )
}

/**
 * Merges time-ordered observations into runs. A run ends at the next
 * observation that differs (or has no text); the last run ends at
 * `coveredUntilSeconds`, the end of the sampled range. Times are whole
 * seconds: starts round down, ends round up.
 */
export function mergeObservations(
  observations: ReadonlyArray<OcrObservation>,
  coveredUntilSeconds: number,
): MergedText[] {
  const ordered = observations.toSorted((a, b) => a.timestampSeconds - b.timestampSeconds)
  const runs: Array<{members: OcrObservation[]; endSeconds: number}> = []
  let current: OcrObservation[] | null = null

  for (const observation of ordered) {
    const text = normalizeOcrText(observation.text)
    if (current && text && isSameText(current[0].text, text)) {
      current.push({...observation, text})
      continue
    }
    if (current) runs.push({members: current, endSeconds: observation.timestampSeconds})
    current = text ? [{...observation, text}] : null
  }
  if (current) runs.push({members: current, endSeconds: Math.max(coveredUntilSeconds, current.at(-1)!.timestampSeconds)})

  return runs.map(({members, endSeconds}) => {
    const kept = members.reduce((best, member) =>
      (member.confidence ?? -1) > (best.confidence ?? -1) ? member : best,
    )
    const startSeconds = Math.floor(members[0].timestampSeconds)
    return {
      text: kept.text,
      startSeconds,
      endSeconds: Math.max(startSeconds, Math.ceil(endSeconds)),
      frame: {timestampSeconds: kept.timestampSeconds, frameHash: kept.frameHash},
      ocrConfidence: kept.confidence,
      textDensity: kept.textDensity,
    }
  })
}

function comparisonKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

type Token = {text: string; codeLine: boolean}

function tokens(text: string): Token[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const codeLine = CODE_LINE.test(line)
    return line
      .split(/\s+/)
      .filter(Boolean)
      .map((token) => ({text: token, codeLine}))
  })
}

function isMaterial(token: Token): boolean {
  return token.codeLine || OPERATOR_CHARS.test(token.text) || IDENTIFIER_MARKS.test(token.text)
}

/** Whether two differing tokens read as one word misrecognized, not a changed word. */
function isNoisePair(a: Token, b: Token): boolean {
  if (isMaterial(a) || isMaterial(b)) return false
  if (Math.min(a.text.length, b.text.length) < MIN_NOISE_TOKEN_LENGTH) return false
  return editDistance(a.text, b.text) <= MAX_NOISE_EDITS
}

type Hunk = {removed: Token[]; added: Token[]}

/** Runs of tokens outside the longest common token subsequence, with what replaced them. */
function changedHunks(a: Token[], b: Token[]): Hunk[] {
  const cols = b.length + 1
  const lcs = new Uint32Array((a.length + 1) * cols)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * cols + j] =
        a[i].text === b[j].text
          ? lcs[(i + 1) * cols + j + 1] + 1
          : Math.max(lcs[(i + 1) * cols + j], lcs[i * cols + j + 1])
    }
  }
  const hunks: Hunk[] = []
  let hunk: Hunk = {removed: [], added: []}
  const flush = () => {
    if (hunk.removed.length > 0 || hunk.added.length > 0) hunks.push(hunk)
    hunk = {removed: [], added: []}
  }
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i].text === b[j].text) {
      flush()
      i++
      j++
    } else if (j >= b.length || (i < a.length && lcs[(i + 1) * cols + j] >= lcs[i * cols + j + 1])) {
      hunk.removed.push(a[i++])
    } else {
      hunk.added.push(b[j++])
    }
  }
  flush()
  return hunks
}

/**
 * 1 − Levenshtein distance / longer length, over characters. Returns 0 early
 * when the length gap alone rules out `MERGE_SIMILARITY`.
 */
function similarity(a: string, b: string): number {
  const longer = Math.max(a.length, b.length)
  if (longer === 0) return 1
  if (Math.abs(a.length - b.length) / longer > 1 - MERGE_SIMILARITY) return 0
  return 1 - editDistance(a, b) / longer
}

/** Levenshtein distance over characters. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0
  let previous = new Uint32Array(b.length + 1).map((_, j) => j)
  let current = new Uint32Array(b.length + 1)
  for (let i = 1; i <= a.length; i++) {
    current[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
    }
    ;[previous, current] = [current, previous]
  }
  return previous[b.length]
}
