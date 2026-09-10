/**
 * GROQ candidate-query builders for search retrieval (SEARCH.md §4–§5).
 *
 * These are built dynamically because GROQ `match` with an array right-hand
 * side ANDs its tokens — OR semantics over keyword variants require explicit
 * `field match "term*" || …` chains. Every inlined term is re-validated
 * against SAFE_TERM here (defense in depth on top of `sanitizeTerms`), so the
 * strings can never break out of the GROQ literal.
 *
 * The queries run through the Context MCP `groq_query` tool, so the Context
 * document's `groqFilter` scope applies on top of these filters. Projections
 * stay minimal: only fields needed for matching, ranking, and result
 * construction. Transcript chunks are filtered by match and hard-bounded —
 * whole transcripts never enter the request path.
 */

const SAFE_TERM = /^[a-z0-9-]{2,32}$/

export const MAX_LESSON_CANDIDATES = 40
export const MAX_VIDEO_CANDIDATES = 20
export const MAX_COURSE_CANDIDATES = 8
export const MAX_MOMENTS_PER_VIDEO = 6
export const MAX_LESSON_VIDEO_INDEX = 200

function assertSafeTerms(terms: ReadonlyArray<string>): void {
  if (terms.length === 0) throw new Error('search terms must not be empty')
  for (const term of terms) {
    if (!SAFE_TERM.test(term)) throw new Error(`unsafe search term: ${JSON.stringify(term)}`)
  }
}

/** `field match "a*" || field match "b*" || …` (terms are prefix-wildcarded). */
function orMatch(field: string, terms: ReadonlyArray<string>): string {
  return terms.map((term) => `${field} match "${term}*"`).join(' || ')
}

/** Reverse course reference with the modules map needed to derive positions. */
const courseContextProjection = /* groq */ `
  "course": *[_type == "course" && references(^._id)] | order(_createdAt asc)[0]{
    _id,
    title,
    "slug": slug.current,
    level,
    "coverImageUrl": coverImage.asset->url,
    modules[]{ _key, title, "lessonIds": lessons[]._ref }
  }
`

/**
 * Lessons matching the terms in structured topic fields or the plain-text
 * projection of the Portable Text notes. Notes text is matched in GROQ and
 * reported as per-term booleans — the text itself never travels.
 */
export function buildLessonCandidatesQuery(terms: ReadonlyArray<string>): string {
  assertSafeTerms(terms)
  const notesHits = terms.map((term) => `pt::text(notes) match "${term}*"`).join(', ')
  return /* groq */ `
    *[_type == "lesson" && (
      ${orMatch('title', terms)} ||
      ${orMatch('keyPoints', terms)} ||
      ${orMatch('proTip', terms)} ||
      ${orMatch('pt::text(notes)', terms)}
    )][0...${MAX_LESSON_CANDIDATES}]{
      _id,
      title,
      "slug": slug.current,
      durationSeconds,
      freePreview,
      "posterUrl": poster.asset->url,
      keyPoints,
      proTip,
      "notesHits": [${notesHits}],
      ${courseContextProjection}
    }
  `
}

/**
 * Video documents with matching chapter labels or transcript chunks.
 * Both moment arrays are filtered by match and sliced — never whole.
 * Video→lesson resolution happens server-side against the lesson-video index.
 */
export function buildVideoCandidatesQuery(terms: ReadonlyArray<string>): string {
  assertSafeTerms(terms)
  return /* groq */ `
    *[_type == "video" && (
      ${orMatch('chapters[].label', terms)} ||
      ${orMatch('transcriptChunks[].text', terms)}
    )][0...${MAX_VIDEO_CANDIDATES}]{
      _id,
      videoId,
      "chapterMatches": chapters[${orMatch('label', terms)}][0...${MAX_MOMENTS_PER_VIDEO}]{ startSeconds, label },
      "transcriptMatches": transcriptChunks[${orMatch('text', terms)}][0...${MAX_MOMENTS_PER_VIDEO}]{ startSeconds, text }
    }
  `
}

/**
 * Courses matching by title/summary contribute their lessons as broad-tier
 * candidates ("search over courses and lessons"); the course itself is never
 * a result type.
 */
export function buildCourseCandidatesQuery(terms: ReadonlyArray<string>): string {
  assertSafeTerms(terms)
  return /* groq */ `
    *[_type == "course" && (
      ${orMatch('title', terms)} ||
      ${orMatch('summary', terms)}
    )][0...${MAX_COURSE_CANDIDATES}]{
      _id,
      title,
      "slug": slug.current,
      level,
      summary,
      "coverImageUrl": coverImage.asset->url,
      modules[]{
        _key,
        title,
        "lessons": lessons[]->{
          _id,
          title,
          "slug": slug.current,
          durationSeconds,
          freePreview,
          "posterUrl": poster.asset->url,
          keyPoints,
          proTip
        }
      }
    }
  `
}

/**
 * Minimal index of lessons that have a video, used to ground video moments to
 * the lesson that uses the video (`parseVideoUrl(videoUrl).videoId` must equal
 * the video document's `videoId`; unresolved moments are dropped).
 */
export const LESSON_VIDEO_INDEX_QUERY = /* groq */ `
  *[_type == "lesson" && defined(videoUrl)][0...${MAX_LESSON_VIDEO_INDEX}]{
    _id,
    title,
    "slug": slug.current,
    durationSeconds,
    freePreview,
    "posterUrl": poster.asset->url,
    videoUrl,
    ${courseContextProjection}
  }
`
