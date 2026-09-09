import 'server-only'

import {parseVideoUrl} from '@/lib/video/provider'

import {cacheTags, sanityFetch} from '../lib/fetch'
import {VIDEO_BY_VIDEO_ID_QUERY} from '../queries/videos'

/**
 * Resolves the ingested video record for a lesson's video URL.
 * Returns `null` for an unsupported/malformed URL or when nothing was ingested
 * — callers must treat that as "no chapters/moments available", never invent them.
 */
export async function getVideoForUrl(videoUrl: string | null | undefined) {
  const parsed = parseVideoUrl(videoUrl)
  if (!parsed) return null
  return sanityFetch({
    query: VIDEO_BY_VIDEO_ID_QUERY,
    params: {videoId: parsed.videoId},
    tags: [cacheTags.video],
  })
}
