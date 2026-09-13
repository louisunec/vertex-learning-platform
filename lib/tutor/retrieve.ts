import type {EvidenceChunk, RetrievalScope} from '../ai/tutor.ts'
import {toSourceChunks, type StoredChunk} from '../evidence/chunks.ts'
import {countTermHits} from '../search/terms.ts'
import {MAX_CHUNK_SECONDS} from '../video/ingest.ts'
import {parseVideoUrl} from '../video/provider.ts'
import type {TutorLesson, TutorSource, TutorVideo} from './source.ts'

/**
 * Time-anchored retrieval for the tutor (development plan §5 PR-6). One
 * deterministic pass through three tiers, each hard-bounded:
 *
 * 1. `window`: chunks of the lesson video overlapping ±90 s of the playhead.
 * 2. `lesson`: when no window chunk strongly matches the question,
 *    same-video chunks outside the window that prefix-match a term.
 * 3. `course`: when no lesson chunk strongly matches either, matching
 *    chunks from the other lessons of the parent course.
 *
 * A chunk matches strongly when it contains two question terms, or the only
 * one: a single incidental word ("contextually") must not stop the search.
 *
 * `scope` reports the widest tier searched. A question with no topic terms
 * stays in the window. A course-tier chunk counts only when its video
 * resolves to a published lesson, which its citation then points at.
 */

export const WINDOW_SECONDS = 90
export const MAX_WINDOW_CHUNKS = 14
export const MAX_LESSON_CHUNKS = 8
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

async function lessonChunks(
  source: TutorSource,
  scope: TutorLessonScope,
  currentSeconds: number,
  terms: readonly string[],
): Promise<EvidenceChunk[]> {
  if (!scope.video) return []
  const video = scope.video
  const [row] = await source.searchChunks([video.id], terms, windowRange(currentSeconds).fetch, LESSON_FETCH)
  return (row?.chunks ?? [])
    .flatMap((chunk) => isolated(video, chunk, scope.lesson))
    .filter((chunk) => countTermHits(chunk.text, terms) > 0)
    .toSorted(byRelevance(terms))
    .slice(0, MAX_LESSON_CHUNKS)
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
  {currentSeconds, terms}: {currentSeconds: number; terms: readonly string[]},
): Promise<TutorRetrieval> {
  const strong = (chunk: EvidenceChunk) => countTermHits(chunk.text, terms) >= Math.min(STRONG_MATCH_TERMS, terms.length)
  const window = await windowChunks(source, scope, currentSeconds)
  if (terms.length === 0 || window.some(strong)) return {scope: 'window', chunks: capEvidence([window])}

  const lesson = await lessonChunks(source, scope, currentSeconds, terms)
  if (lesson.some(strong) || scope.courseLessons.length === 0) {
    return {scope: 'lesson', chunks: capEvidence([window, lesson])}
  }

  const course = await courseChunks(source, scope, terms)
  return {scope: 'course', chunks: capEvidence([window, lesson, course])}
}
