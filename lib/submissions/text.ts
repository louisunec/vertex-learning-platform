/**
 * Submitted code as both the browser and the server see it (development plan
 * §5 PR-12). One normalization, so a line number in a finding points at the
 * same line the learner sees: line endings become `\n` and trailing
 * whitespace at the end is dropped; nothing else changes. Framework-free and
 * without `node:crypto` so the client bundle can use it.
 */

export const MAX_SUBMISSION_CHARS = 8000
export const MAX_SUBMISSION_LINES = 200

export type NormalizedSubmission = {
  content: string
  lines: string[]
  lineCount: number
  charCount: number
}

export type SubmissionProblem = 'empty' | 'too_long' | 'too_many_lines' | 'control_characters'

export type NormalizeResult = {ok: true; value: NormalizedSubmission} | {ok: false; problem: SubmissionProblem}

/** Control characters other than tab and newline (a carriage return is normalized first). */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/

export function normalizeSubmission(raw: string): NormalizeResult {
  const content = raw.replace(/\r\n?/g, '\n').replace(/\s+$/u, '')
  if (content.trim().length === 0) return {ok: false, problem: 'empty'}
  if (CONTROL.test(content)) return {ok: false, problem: 'control_characters'}
  if (content.length > MAX_SUBMISSION_CHARS) return {ok: false, problem: 'too_long'}
  const lines = content.split('\n')
  if (lines.length > MAX_SUBMISSION_LINES) return {ok: false, problem: 'too_many_lines'}
  return {ok: true, value: {content, lines, lineCount: lines.length, charCount: content.length}}
}

/** "line 4" or "lines 4–6". */
export function lineRangeText(start: number, end: number): string {
  return start === end ? `line ${start}` : `lines ${start}–${end}`
}
