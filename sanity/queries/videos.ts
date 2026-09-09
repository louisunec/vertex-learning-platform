import {defineQuery} from 'next-sanity'

/**
 * Video lookup by stable id (derived from the lesson's video URL with
 * `parseVideoUrl`). Returns chapters only — transcript chunks never travel
 * through the request path except as bounded, filtered search matches.
 * If duplicate records exist for one URL, the oldest wins deterministically.
 */
export const VIDEO_BY_VIDEO_ID_QUERY = defineQuery(/* groq */ `
  *[_type == "video" && videoId == $videoId] | order(_createdAt asc)[0] {
    _id,
    videoId,
    provider,
    providerVideoId,
    sourceUrl,
    title,
    durationSeconds,
    ingestedAt,
    chapters[] { _key, startSeconds, label },
    "transcriptChunkCount": count(transcriptChunks)
  }
`)
