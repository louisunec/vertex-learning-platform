import type {EvidenceChunk, RetrievalScope} from '../ai/tutor.ts'
import {toSourceChunks, type StoredChunk} from '../evidence/chunks.ts'
import {countTermHits} from '../search/terms.ts'
import {MAX_CHUNK_SECONDS} from '../video/ingest.ts'
import {parseVideoUrl} from '../video/provider.ts'
import type {ChunkRange, TutorLesson, TutorSource, TutorVideo} from './source.ts'

/**
 * Time-anchored retrieval for the tutor (development plan §5 PR-6). One
 * deterministic pass through three tiers, each hard-bounded:
 *
 * 1. `window`: chunks of the lesson video overlapping ±90 s of the playhead.
 *    A question with no topic words stays here.
 * 2. `lesson`: always searched when the question has topic words. Chapters
 *    first (AGENTS.md §9): chunks inside a chapter whose label matches a
 *    term; then same-video chunks outside the window that prefix-match one,
 *    the best few each followed by their neighbours (a ≤30 s chunk often
 *    cuts the sentence that answers the question).
 * 3. `course`: when neither tier holds a strong match for the learner's own
 *    words, matching chunks from the other lessons of the parent course.
 *
 * `terms` are the learner's words plus fixed list words
 * (`lib/tutor/terms.ts`), used for recall and ranking. `baseTerms` are
 * the learner's words alone: a chunk matches strongly when it contains two
 * of them, or the only one, so a list word or a single incidental word
 * ("contextually") never stops the search. `scope` reports the widest tier
 * searched. A course-tier chunk counts only when its video resolves to a
 * published lesson, which its citation then points at.
 */

export const WINDOW_SECONDS = 90
export const MAX_WINDOW_CHUNKS = 14
export const MAX_LESSON_CHUNKS = 8
/** Top lesson-tier hits whose previous and next chunks join the evidence. */
export const NEIGHBOR_HITS = 3
/** Chapters whose label matches a term, and chunks taken from their spans (split evenly). */
export const MAX_MATCHED_CHAPTERS = 2
export const MAX_CHAPTER_CHUNKS = 8
export const MAX_COURSE_LESSONS = 20
export const MAX_CHUNKS_PER_COURSE_VIDEO = 3
export const MAX_COURSE_CHUNKS = 12
export const MAX_EVIDENCE_CHUNKS = 30
export const MAX_EVIDENCE_CHARS = 9000
/** Question terms a chunk must contain to count as a strong match (fewer when the question has fewer). */
export const STRONG_MATCH_TERMS = 2

/** Fetch bounds before ranking (GROQ returns matches in time order, not by relevance). */
const WINDOW_FETCH = 32
const LESSON_FETCH = 16
const COURSE_FETCH_PER_VIDEO = 8
/** Chunks read around a hit to find its neighbours (±30 s holds one of each at the usual ~18 s). */
const NEIGHBOR_FETCH = 7

/** The lesson being watched, its video, and the course lessons eligible for the course tier. */
export type TutorLessonScope = {
  lesson: TutorLesson
  video: TutorVideo | null
  /** The video's duration, else the lesson's; null when neither is stored. */
  durationSeconds: number | null
  courseLessons: TutorLesson[]
}

export type TutorRetrieval = {scope: RetrievalScope; chunks: EvidenceChunk[]}

/** The published lesson and its video, or null when the lesson is not published. */
export async function resolveLessonScope(source: TutorSource, lessonId: string): Promise<TutorLessonScope | null> {
  const context = await source.loadLesson(lessonId)
  if (!context) return null
  const {courseLessons, ...lesson} = context
  const parsed = parseVideoUrl(lesson.videoUrl)
  const [video = null] = parsed ? await source.loadVideos([parsed.videoId]) : []
  const seen = new Set([lesson.id])
  return {
    lesson,
    video,
    durationSeconds: video?.durationSeconds ?? lesson.durationSeconds,
    courseLessons: courseLessons
      .filter((candidate) => !seen.has(candidate.id) && seen.add(candidate.id))
      .slice(0, MAX_COURSE_LESSONS),
  }
}

/** One stored chunk's identity, computed on its own (its end is `start + 30 s`, capped by the duration). */
function isolated(video: TutorVideo, chunk: StoredChunk, lesson: TutorLesson): EvidenceChunk[] {
  return toSourceChunks({_id: video.id, durationSeconds: video.durationSeconds, transcriptChunks: [chunk]}).map((source) => ({
    ...source,
    lessonId: lesson.id,
    lessonTitle: lesson.title,
    lessonSlug: lesson.slug,
  }))
}

/** Most term hits first, then earlier in the video. */
function byRelevance(terms: readonly string[]) {
  return (a: EvidenceChunk, b: EvidenceChunk) =>
    countTermHits(b.text, terms) - countTermHits(a.text, terms) || a.startSeconds - b.startSeconds
}

export function windowRange(currentSeconds: number) {
  return {
    /** A chunk starting up to 30 s earlier can still overlap the window. */
    fetch: {fromSeconds: Math.max(0, currentSeconds - WINDOW_SECONDS - MAX_CHUNK_SECONDS), toSeconds: currentSeconds + WINDOW_SECONDS},
    overlap: {fromSeconds: Math.max(0, currentSeconds - WINDOW_SECONDS), toSeconds: currentSeconds + WINDOW_SECONDS},
  }
}

async function windowChunks(source: TutorSource, scope: TutorLessonScope, currentSeconds: number): Promise<EvidenceChunk[]> {
  if (!scope.video) return []
  const {fetch, overlap} = windowRange(currentSeconds)
  const stored = await source.loadWindow(scope.video.id, fetch, WINDOW_FETCH)
  const {lesson, video} = scope
  const distance = (chunk: EvidenceChunk) => Math.abs((chunk.startSeconds + chunk.endSeconds) / 2 - currentSeconds)
  return toSourceChunks({_id: video.id, durationSeconds: video.durationSeconds, transcriptChunks: stored})
    .filter((chunk) => chunk.endSeconds > overlap.fromSeconds && chunk.startSeconds <= overlap.toSeconds)
    .map((chunk) => ({...chunk, lessonId: lesson.id, lessonTitle: lesson.title, lessonSlug: lesson.slug}))
    .toSorted((a, b) => distance(a) - distance(b))
    .slice(0, MAX_WINDOW_CHUNKS)
    .toSorted((a, b) => a.startSeconds - b.startSeconds)
}

/** `span` without the part `window` already covers: zero, one, or two ranges. */
function outside(span: ChunkRange, window: ChunkRange): ChunkRange[] {
  const ranges: ChunkRange[] = []
  if (span.fromSeconds < window.fromSeconds) ranges.push({fromSeconds: span.fromSeconds, toSeconds: Math.min(span.toSeconds, window.fromSeconds - 1)})
  if (span.toSeconds > window.toSeconds) ranges.push({fromSeconds: Math.max(span.fromSeconds, window.toSeconds + 1), toSeconds: span.toSeconds})
  return ranges.filter((range) => range.toSeconds >= range.fromSeconds)
}

/**
 * Chunks inside the spans of chapters whose label matches a term, outside
 * the window (already searched). The budget is split evenly between the
 * matched chapters, so the chapter around the playhead cannot crowd out a
 * later one (a "Pros and Cons" chapter for a question about downsides).
 */
async function chapterChunks(
  source: TutorSource,
  scope: TutorLessonScope,
  currentSeconds: number,
  terms: readonly string[],
): Promise<EvidenceChunk[]> {
  const video = scope.video
  if (!video || video.chapters.length === 0) return []
  const window = windowRange(currentSeconds).overlap
  const spans = video.chapters
    .map((chapter, i) => ({
      hits: countTermHits(chapter.label, terms),
      fromSeconds: chapter.startSeconds,
      // A chapter ends where the next begins, else at the video end.
      toSeconds: (video.chapters[i + 1]?.startSeconds ?? video.durationSeconds ?? chapter.startSeconds + 600) - 1,
    }))
    // A chapter wholly inside the window adds nothing and must not take a slot.
    .filter((span) => span.hits > 0 && span.toSeconds >= span.fromSeconds && outside(span, window).length > 0)
    .toSorted((a, b) => b.hits - a.hits || a.fromSeconds - b.fromSeconds)
    .slice(0, MAX_MATCHED_CHAPTERS)
  if (spans.length === 0) return []

  const quota = Math.floor(MAX_CHAPTER_CHUNKS / spans.length)
  const perChapter = await Promise.all(
    spans.map(async (span) => {
      const chunks: EvidenceChunk[] = []
      for (const range of outside(span, window)) {
        if (chunks.length >= quota) break
        const stored = await source.loadWindow(video.id, range, quota - chunks.length)
        for (const chunk of toSourceChunks({_id: video.id, durationSeconds: video.durationSeconds, transcriptChunks: stored})) {
          chunks.push({...chunk, lessonId: scope.lesson.id, lessonTitle: scope.lesson.title, lessonSlug: scope.lesson.slug})
        }
      }
      return chunks.slice(0, quota)
    }),
  )
  return perChapter.flat()
}

async function lessonChunks(
  source: TutorSource,
  scope: TutorLessonScope,
  currentSeconds: number,
  terms: readonly string[],
): Promise<EvidenceChunk[]> {
  if (!scope.video) return []
  const video = scope.video
  const [row] = await source.searchChunks([video.id], terms, windowRange(currentSeconds).fetch, LESSON_FETCH)
  const hits = (row?.chunks ?? [])
    .flatMap((chunk) => isolated(video, chunk, scope.lesson))
    .filter((chunk) => countTermHits(chunk.text, terms) > 0)
    .toSorted(byRelevance(terms))
    .slice(0, MAX_LESSON_CHUNKS)
  const neighbors = await Promise.all(hits.slice(0, NEIGHBOR_HITS).map((hit) => neighborChunks(source, scope, video, hit)))
  // Each of the best hits is followed by its neighbours, then the remaining hits.
  return [...hits.slice(0, NEIGHBOR_HITS).flatMap((hit, i) => [hit, ...neighbors[i]]), ...hits.slice(NEIGHBOR_HITS)]
}

/** The chunks just before and just after `hit` in its video (zero to two). */
async function neighborChunks(source: TutorSource, scope: TutorLessonScope, video: TutorVideo, hit: EvidenceChunk): Promise<EvidenceChunk[]> {
  const range = {fromSeconds: Math.max(0, hit.startSeconds - MAX_CHUNK_SECONDS), toSeconds: hit.startSeconds + MAX_CHUNK_SECONDS}
  const stored = await source.loadWindow(video.id, range, NEIGHBOR_FETCH)
  const at = stored.findIndex((chunk) => chunk.startSeconds === hit.startSeconds)
  if (at < 0) return []
  return [stored[at - 1], stored[at + 1]].flatMap((chunk) => (chunk ? isolated(video, chunk, scope.lesson) : []))
}

async function courseChunks(source: TutorSource, scope: TutorLessonScope, terms: readonly string[]): Promise<EvidenceChunk[]> {
  const lessonsByVideoId = new Map<string, TutorLesson>()
  for (const lesson of scope.courseLessons) {
    const parsed = parseVideoUrl(lesson.videoUrl)
    // The current lesson's video was already searched; the first lesson using a video owns it.
    if (!parsed || parsed.videoId === scope.video?.videoId || lessonsByVideoId.has(parsed.videoId)) continue
    lessonsByVideoId.set(parsed.videoId, lesson)
  }
  if (lessonsByVideoId.size === 0) return []

  const videos = await source.loadVideos([...lessonsByVideoId.keys()])
  const videosById = new Map(videos.map((video) => [video.id, video]))
  const rows = await source.searchChunks(
    videos.map((video) => video.id),
    terms,
    null,
    COURSE_FETCH_PER_VIDEO,
  )
  const order = [...lessonsByVideoId.values()].map((lesson) => lesson.id)
  return rows
    .flatMap((row) => {
      const video = videosById.get(row.videoDocumentId)
      const lesson = video && lessonsByVideoId.get(video.videoId)
      if (!video || !lesson) return []
      return row.chunks
        .flatMap((chunk) => isolated(video, chunk, lesson))
        .filter((chunk) => countTermHits(chunk.text, terms) > 0)
        .toSorted(byRelevance(terms))
        .slice(0, MAX_CHUNKS_PER_COURSE_VIDEO)
    })
    .toSorted(
      (a, b) =>
        countTermHits(b.text, terms) - countTermHits(a.text, terms) ||
        order.indexOf(a.lessonId) - order.indexOf(b.lessonId) ||
        a.startSeconds - b.startSeconds,
    )
    .slice(0, MAX_COURSE_CHUNKS)
}

/** Keeps tier order (window, lesson, course) within the chunk and character caps, without duplicates. */
function capEvidence(tiers: ReadonlyArray<readonly EvidenceChunk[]>): EvidenceChunk[] {
  const kept: EvidenceChunk[] = []
  const ids = new Set<string>()
  let chars = 0
  for (const chunk of tiers.flat()) {
    if (kept.length >= MAX_EVIDENCE_CHUNKS) break
    if (ids.has(chunk.chunkId) || chars + chunk.text.length > MAX_EVIDENCE_CHARS) continue
    ids.add(chunk.chunkId)
    chars += chunk.text.length
    kept.push(chunk)
  }
  return kept
}

export async function retrieveEvidence(
  source: TutorSource,
  scope: TutorLessonScope,
  {currentSeconds, terms, baseTerms = terms}: {currentSeconds: number; terms: readonly string[]; baseTerms?: readonly string[]},
): Promise<TutorRetrieval> {
  const window = await windowChunks(source, scope, currentSeconds)
  if (terms.length === 0) return {scope: 'window', chunks: capEvidence([window])}

  const [chapters, lesson] = await Promise.all([
    chapterChunks(source, scope, currentSeconds, terms),
    lessonChunks(source, scope, currentSeconds, terms),
  ])
  const strong = (chunk: EvidenceChunk) =>
    baseTerms.length > 0 && countTermHits(chunk.text, baseTerms) >= Math.min(STRONG_MATCH_TERMS, baseTerms.length)
  // Chapter chunks go first after the window: a chapter title match is the most specific signal.
  const lessonTiers = [window, chapters, lesson]
  if (lessonTiers.some((tier) => tier.some(strong)) || scope.courseLessons.length === 0) {
    return {scope: 'lesson', chunks: capEvidence(lessonTiers)}
  }

  const course = await courseChunks(source, scope, terms)
  return {scope: 'course', chunks: capEvidence([...lessonTiers, course])}
}
