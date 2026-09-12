import {hashParts} from '../evidence/chunks.ts'
import type {AssessmentDraft} from './generate.ts'
import type {GenerationRecord} from './pipeline.ts'

/**
 * Deterministic quality checks for generated assessment candidates
 * (development plan §5 PR-1), found by the pilot dry-run audits
 * (`prompts/pr-1-candidate-audit.md`): option order, wording that points at a
 * source learners never see, positional option references, cut-off or
 * corrupted text, and answer-length cues. Lexical rules only — human review
 * before publishing stays the gate. Each `find*` returns the matched text (for
 * the rejection reason) or null.
 */

/**
 * Fisher–Yates shuffle driven by sha256 of `seed`, so the same seed always
 * yields the same order. Removes the model's habit of listing the correct
 * option first.
 */
export function seededShuffle<T>(items: ReadonlyArray<T>, seed: string): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Number.parseInt(hashParts([seed, String(i)]).slice(0, 8), 16) % (i + 1)
    const swap = out[i]
    out[i] = out[j]
    out[j] = swap
  }
  return out
}

function findFirst(patterns: ReadonlyArray<RegExp>, text: string): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match) return match[0].toLowerCase()
  }
  return null
}

/**
 * Words that describe the generator's input rather than the subject. All
 * learner-visible text — question, options, reasons, hints — must read as
 * standalone teaching text, so none may say "the span", "the instructor", or
 * "according to the passage".
 */
const GENERATOR_LANGUAGE = [
  /\b(span|passage|excerpt|transcript|chunk|speaker|presenter|narrator|section|instructor|demo|demonstration)s?\b/i,
  /\baccording to the (text|span|passage|lesson|video|speaker|presenter|instructor|transcript|section|excerpt|source|demo|demonstration)\b/i,
  /\b(this|the) (video|lesson|clip)\b/i,
  /\bthe demonstrated\b/i,
]

export function findGeneratorLanguage(text: string): string | null {
  return findFirst(GENERATOR_LANGUAGE, text)
}

/**
 * Directions to text learners cannot see: "Find the sentence that…", "Look at
 * the lines describing…", "Refer to the statement about…". Nouns that are
 * common in the subject itself ("statement" in SQL, "comment" in code,
 * "example" in a question) only count after a look/find verb or not at all.
 */
const SOURCE_POINTER = [
  /\b(the|these|those|this|that)\s+(sentences?|lines?|parts?|portions?|segments?|remarks?|discussion|description|warning|analogy|walkthrough)\s+(that|which|where|about|describing|explaining|mentioning|discussing|comparing|contrasting|listing|naming|defining|showing|on)\b/i,
  /\b(re-?read|look at|look for|look in|find|check|refer to|review|revisit)\s+(?:\S+\s+){0,3}?(sentences?|statements?|remarks?|discussion|description|analogy|walkthrough|recommendation|guidance|warning)\b/i,
]

export function findSourcePointer(text: string): string | null {
  return findFirst(SOURCE_POINTER, text)
}

/** The prompt's internal chunk labels (`c0`, `c1`…). Lowercase only, so "C2 server" is not one. */
const CHUNK_LABEL = [/(?<![\p{L}\p{N}_-])c\d{1,2}(?![\p{L}\p{N}_])/u]

export function findChunkLabel(text: string): string | null {
  return findFirst(CHUNK_LABEL, text)
}

/**
 * "option 1", "Answer B", "(choice 3)", "the first option". Options are
 * shuffled after generation, so positional references in any learner-visible
 * text would point at the wrong option. Letters must be capitals so "answer a
 * question" is not a reference.
 */
const POSITIONAL_REFERENCE = [
  /\b[Oo]ptions?\s*\(?(?:[1-4]|[A-D])\)?(?![\p{L}\p{N}-])/u,
  /\b[Aa]nswers?\s*\(?(?:[1-4]|[A-D])\)?(?![\p{L}\p{N}-])/u,
  /\b[Cc]hoices?\s*\(?(?:[1-4]|[A-D])\)?(?![\p{L}\p{N}-])/u,
  /\b(first|second|third|fourth|last)\s+(option|answer|choice)s?\b/i,
]

export function findPositionalReference(text: string): string | null {
  return findFirst(POSITIONAL_REFERENCE, text)
}

/**
 * Whether a sentence field (question, reason, hint) stops without sentence
 * punctuation — the signature of text cut at a length limit mid-word. Options
 * are phrases and are not checked.
 */
export function looksTruncated(text: string): boolean {
  return !/[.?!:)"'”’`。？！：）」』]$/.test(text.trim())
}

const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu
const LATIN_CHAR = /\p{Script=Latin}/gu
/** Share of Latin letters above which any CJK character is treated as corruption. */
const LATIN_DOMINANT = 0.8

/**
 * Whether mostly Latin-script text contains Han, Kana, or Hangul characters —
 * the stray tokens seen where decoding was forced to stop ("…confirm誰").
 * Text written mainly in a CJK script (a lesson in Chinese) is not flagged.
 */
export function looksCorrupted(text: string): boolean {
  const cjk = text.match(CJK_CHAR)?.length ?? 0
  if (cjk === 0) return false
  const latin = text.match(LATIN_CHAR)?.length ?? 0
  return latin / (latin + cjk) >= LATIN_DOMINANT
}

/**
 * A correct option at least this many times the longest distractor, and at
 * least `ANSWER_LENGTH_MIN_GAP` characters longer, is a length cue. Tuned on
 * the v1 pilot audit, where it flagged 16 of 105 candidates; lengths need not
 * match exactly.
 */
export const ANSWER_LENGTH_RATIO = 1.4
export const ANSWER_LENGTH_MIN_GAP = 15

export function hasAnswerLengthCue(options: ReadonlyArray<string>, correctIndex: number): boolean {
  const lengths = options.map((option) => option.trim().length)
  const correct = lengths[correctIndex]
  const longestDistractor = Math.max(...lengths.filter((_, i) => i !== correctIndex))
  return correct >= longestDistractor * ANSWER_LENGTH_RATIO && correct - longestDistractor >= ANSWER_LENGTH_MIN_GAP
}

type LengthBucket = '<0.8' | '0.8–1.0' | '1.0–1.2' | '1.2–1.4' | '≥1.4'

function lengthBucket(ratio: number): LengthBucket {
  if (ratio < 0.8) return '<0.8'
  if (ratio < 1) return '0.8–1.0'
  if (ratio < 1.2) return '1.0–1.2'
  if (ratio < ANSWER_LENGTH_RATIO) return '1.2–1.4'
  return '≥1.4'
}

export type CandidateSummary = {
  candidates: number
  byType: Record<AssessmentDraft['type'], number>
  /** Correct-option position counts (index 0 = first shown), keyed by option count. */
  correctPosition: Record<string, number[]>
  /** Correct option length ÷ longest distractor length. */
  lengthRatio: Record<LengthBucket, number>
  correctIsLongest: number
  /** Rejections by code (`generator_language`), and by code plus matched term (`generator_language:section`). */
  rejectionReasons: Record<string, number>
  rejectionDetails: Record<string, number>
  outcomes: Record<GenerationRecord['kind'], Record<GenerationRecord['outcome'], number>>
}

/** Run report over accepted drafts and the records of the same run. */
export function summarizeCandidates(
  drafts: ReadonlyArray<AssessmentDraft>,
  records: ReadonlyArray<GenerationRecord>,
): CandidateSummary {
  const summary: CandidateSummary = {
    candidates: drafts.length,
    byType: {recall: 0, apply: 0, transfer: 0},
    correctPosition: {},
    lengthRatio: {'<0.8': 0, '0.8–1.0': 0, '1.0–1.2': 0, '1.2–1.4': 0, '≥1.4': 0},
    correctIsLongest: 0,
    rejectionReasons: {},
    rejectionDetails: {},
    outcomes: {
      section: {drafted: 0, no_candidates: 0, all_rejected: 0},
      lesson_transfer: {drafted: 0, no_candidates: 0, all_rejected: 0},
    },
  }
  for (const draft of drafts) {
    summary.byType[draft.type]++
    const count = String(draft.options.length)
    summary.correctPosition[count] ??= Array.from({length: draft.options.length}, () => 0)
    const correctIndex = draft.options.findIndex((option) => option._key === draft.answerKey.correctOptionId)
    summary.correctPosition[count][correctIndex]++
    const lengths = draft.options.map((option) => option.text.trim().length)
    const longestDistractor = Math.max(...lengths.filter((_, i) => i !== correctIndex))
    summary.lengthRatio[lengthBucket(lengths[correctIndex] / longestDistractor)]++
    if (lengths[correctIndex] > longestDistractor) summary.correctIsLongest++
  }
  for (const record of records) {
    summary.outcomes[record.kind][record.outcome]++
    for (const reason of record.rejectionReasons) {
      const code = reason.split(':')[0]
      summary.rejectionReasons[code] = (summary.rejectionReasons[code] ?? 0) + 1
      summary.rejectionDetails[reason] = (summary.rejectionDetails[reason] ?? 0) + 1
    }
  }
  return summary
}
