import type {LessonSearchResult, SearchResult, VideoSearchResult} from './schema.ts'
import type {LessonCandidate, VideoMomentCandidate} from './retrieve.ts'
import {countTermHits} from './terms.ts'

/**
 * Deterministic final ranking (SEARCH.md §3.3, §6). Pure: results are
 * reproducible from grounded candidate data + these rules, and unit-tested.
 *
 * Tier relationship the weights encode:
 *   strong title/topic match > clean chapter match > structured lesson
 *   content > transcript fallback > broad course-level hit.
 *
 * Terms come in two classes: `primaryTerms` are the learner's own words
 * (deterministic tokenization of the query); the rest of `terms` are LLM
 * expansion variants. Expansion hits count at a reduced weight so synonym
 * recall never lets broad noise outrank specific matches (SEARCH.md §5).
 */
const WEIGHTS = {
  titleHit: 40,
  /** All primary terms present in the title (multi-term queries): exact/specific match. */
  titleAllTermsBonus: 50,
  keyPointHit: 12,
  proTipHit: 8,
  notesHit: 6,
  chapterBase: 15,
  chapterHit: 20,
  transcriptBase: 4,
  transcriptHit: 6,
  broadCourseHit: 5,
} as const

/** Weight of an expansion-term hit relative to a primary-term hit. */
const EXPANSION_WEIGHT = 1 / 3

const MAX_MOMENTS_PER_LESSON = 3

type TermClasses = {
  primary: ReadonlyArray<string>
  expansion: ReadonlyArray<string>
}

function splitTerms(terms: ReadonlyArray<string>, primaryTerms: ReadonlyArray<string>): TermClasses {
  const primarySet = new Set(primaryTerms)
  const primary = terms.filter((term) => primarySet.has(term))
  // Guard: never let an empty primary class zero out all scoring.
  if (primary.length === 0) return {primary: terms, expansion: []}
  return {primary, expansion: terms.filter((term) => !primarySet.has(term))}
}

/** Primary hits count fully; expansion hits count at EXPANSION_WEIGHT. */
function weightedHits(text: string | null | undefined, classes: TermClasses): number {
  return (
    countTermHits(text, classes.primary) + countTermHits(text, classes.expansion) * EXPANSION_WEIGHT
  )
}

function scoreLessonCandidate(
  candidate: LessonCandidate,
  terms: ReadonlyArray<string>,
  classes: TermClasses,
): number {
  let score = weightedHits(candidate.title, classes) * WEIGHTS.titleHit
  const primaryTitleHits = countTermHits(candidate.title, classes.primary)
  if (classes.primary.length >= 2 && primaryTitleHits >= classes.primary.length) {
    score += WEIGHTS.titleAllTermsBonus
  }
  score += weightedHits(candidate.keyPoints.join(' '), classes) * WEIGHTS.keyPointHit
  score += weightedHits(candidate.proTip, classes) * WEIGHTS.proTipHit
  const primarySet = new Set(classes.primary)
  score += candidate.notesHits.reduce(
    (sum, hit, index) =>
      hit ? sum + (primarySet.has(terms[index] ?? '') ? 1 : EXPANSION_WEIGHT) * WEIGHTS.notesHit : sum,
    0,
  )
  if (candidate.broad) {
    score += weightedHits(candidate.courseMatchText, classes) * WEIGHTS.broadCourseHit
  }
  return score
}

function scoreVideoMomentCandidate(candidate: VideoMomentCandidate, classes: TermClasses): number {
  const hits = weightedHits(candidate.momentText, classes)
  if (hits === 0) return 0
  return candidate.matchKind === 'chapter'
    ? WEIGHTS.chapterBase + hits * WEIGHTS.chapterHit
    : WEIGHTS.transcriptBase + hits * WEIGHTS.transcriptHit
}

type Scored<T> = {score: number; result: T}

function toLessonResult(candidate: LessonCandidate): LessonSearchResult {
  return {
    type: 'lesson',
    lessonId: candidate.lessonId,
    title: candidate.title,
    slug: candidate.slug,
    href: `/lessons/${candidate.slug}`,
    description: candidate.proTip ?? candidate.keyPoints[0] ?? candidate.courseSummary ?? '',
    durationSeconds: candidate.durationSeconds,
    freePreview: candidate.freePreview,
    posterUrl: candidate.posterUrl,
    course: candidate.course,
    keyPoints: candidate.keyPoints.slice(0, 4),
  }
}

function toVideoResult(candidate: VideoMomentCandidate): VideoSearchResult {
  return {
    type: 'video',
    lessonId: candidate.lessonId,
    title: candidate.title,
    slug: candidate.slug,
    href: `/lessons/${candidate.slug}?t=${candidate.startSeconds}`,
    description: candidate.momentText,
    durationSeconds: candidate.durationSeconds,
    freePreview: candidate.freePreview,
    posterUrl: candidate.posterUrl,
    course: candidate.course,
    startSeconds: candidate.startSeconds,
    matchKind: candidate.matchKind,
    momentLabel: candidate.momentText,
  }
}

/**
 * Scores, deduplicates, and orders the full merged candidate set. Zero-score
 * candidates (GROQ-side noise the server signals cannot confirm) are dropped
 * rather than padded into results.
 */
export function rankCandidates(
  terms: ReadonlyArray<string>,
  primaryTerms: ReadonlyArray<string>,
  lessons: ReadonlyArray<LessonCandidate>,
  videoMoments: ReadonlyArray<VideoMomentCandidate>,
): SearchResult[] {
  const classes = splitTerms(terms, primaryTerms)

  // Lessons: dedupe by lesson id. When a lesson matched both directly and
  // through its course, the strongest signal wins plus a fraction of the
  // other — still below the next full tier.
  const lessonScores = new Map<string, Scored<LessonSearchResult>>()
  for (const candidate of lessons) {
    const score = scoreLessonCandidate(candidate, terms, classes)
    if (score <= 0) continue
    const existing = lessonScores.get(candidate.lessonId)
    if (!existing) {
      lessonScores.set(candidate.lessonId, {score, result: toLessonResult(candidate)})
    } else {
      const merged = Math.max(existing.score, score) + Math.min(existing.score, score) * 0.25
      const best = score > existing.score ? toLessonResult(candidate) : existing.result
      lessonScores.set(candidate.lessonId, {score: merged, result: best})
    }
  }

  // Video moments: dedupe by lesson + second, then keep at most a few moments
  // per lesson so one video cannot flood the page.
  const momentScores = new Map<string, Scored<VideoSearchResult>>()
  for (const candidate of videoMoments) {
    const score = scoreVideoMomentCandidate(candidate, classes)
    if (score <= 0) continue
    const key = `${candidate.lessonId}@${candidate.startSeconds}`
    const existing = momentScores.get(key)
    if (!existing || score > existing.score) {
      momentScores.set(key, {score, result: toVideoResult(candidate)})
    }
  }
  const momentsPerLesson = new Map<string, number>()
  const keptMoments: Scored<SearchResult>[] = []
  for (const scored of [...momentScores.values()].sort(compareScored)) {
    const count = momentsPerLesson.get(scored.result.lessonId) ?? 0
    if (count >= MAX_MOMENTS_PER_LESSON) continue
    momentsPerLesson.set(scored.result.lessonId, count + 1)
    keptMoments.push(scored)
  }

  return [...lessonScores.values(), ...keptMoments].sort(compareScored).map((scored) => scored.result)
}

/** Stable order: score desc, then title, then href (deterministic tie-break). */
function compareScored(a: Scored<SearchResult>, b: Scored<SearchResult>): number {
  if (b.score !== a.score) return b.score - a.score
  const byTitle = a.result.title.localeCompare(b.result.title)
  if (byTitle !== 0) return byTitle
  return a.result.href.localeCompare(b.result.href)
}
