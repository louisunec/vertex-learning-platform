/**
 * A learner's explanation as both the browser and the server see it
 * (development plan §5 PR-8). One normalization, so a span the server returns
 * points at the same characters the learner sees: line endings become `\n`
 * and surrounding whitespace is dropped; nothing else changes. Framework-free
 * and without `node:crypto` so the client bundle can use it.
 */

export const MIN_EXPLANATION_CHARS = 10
export const MAX_EXPLANATION_CHARS = 1500

export type ExplanationProblem = 'too_short' | 'too_long' | 'control_characters'

export type NormalizeResult = {ok: true; text: string; charCount: number} | {ok: false; problem: ExplanationProblem}

/** Control characters other than tab and newline (a carriage return is normalized first). */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/

export function normalizeExplanation(raw: string): NormalizeResult {
  const text = raw.replace(/\r\n?/g, '\n').trim()
  if (CONTROL.test(text)) return {ok: false, problem: 'control_characters'}
  if (text.length < MIN_EXPLANATION_CHARS) return {ok: false, problem: 'too_short'}
  if (text.length > MAX_EXPLANATION_CHARS) return {ok: false, problem: 'too_long'}
  return {ok: true, text, charCount: text.length}
}

/** Quotation marks and ellipses a model may wrap around a quote it copied. */
const WRAPPING = /^[\s"'“”‘’«»…]+|[\s"'“”‘’«»…]+$|^\.{3}|\.{3}$/g

const MIN_QUOTE_CHARS = 3

/**
 * Where `quote` occurs in `text`, ignoring case and runs of whitespace, as
 * offsets into `text`; null when it does not occur. The server locates a
 * model's quote itself and never trusts model-supplied offsets.
 */
export function locateQuote(text: string, quote: string): {start: number; end: number} | null {
  const needle = quote.replace(WRAPPING, '').replace(/\s+/g, ' ').toLowerCase()
  if (needle.length < MIN_QUOTE_CHARS) return null

  // `folded` is `text` lower-cased with each whitespace run as one space; `origin[i]` is where folded[i] came from.
  let folded = ''
  const origin: number[] = []
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (/\s/.test(char)) {
      if (folded.endsWith(' ')) continue
      folded += ' '
      origin.push(i)
      continue
    }
    // Lower-casing can lengthen a character (İ → i̇); every piece maps back to it.
    for (const piece of char.toLowerCase()) {
      folded += piece
      for (let n = 0; n < piece.length; n++) origin.push(i)
    }
  }

  const at = folded.indexOf(needle)
  if (at < 0) return null
  return {start: origin[at], end: origin[at + needle.length - 1] + 1}
}

/** Runs of this many consecutive words of a private point, copied into learner-facing text, count as a rubric leak. */
export const LEAK_WORDS = 8

const words = (text: string) => text.toLowerCase().match(/[a-z0-9']+/g) ?? []

/** Whether `text` repeats `LEAK_WORDS` consecutive words of `point` (case and punctuation ignored). A paraphrase passes. */
export function copiesPoint(text: string, point: string): boolean {
  const haystack = ` ${words(text).join(' ')} `
  const needle = words(point)
  for (let i = 0; i + LEAK_WORDS <= needle.length; i++) {
    if (haystack.includes(` ${needle.slice(i, i + LEAK_WORDS).join(' ')} `)) return true
  }
  return false
}
