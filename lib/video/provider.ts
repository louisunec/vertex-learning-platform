/**
 * Provider detection and stable video identity.
 *
 * Shared by the web app (lesson ↔ video lookup, embeds) and the offline
 * ingestion tool (document ids). Framework-free on purpose.
 *
 * Normalization is deliberately conservative: only the provider's own video
 * id is used for identity, so trivial URL variants (share links, embed URLs,
 * tracking params) collapse to one record while genuinely different videos
 * never merge.
 */

export type VideoProvider = 'youtube' | 'vimeo' | 'bunny'

export type ParsedVideo = {
  provider: VideoProvider
  /** Provider-native id (YouTube id, Vimeo numeric id, Bunny `libraryId/guid`). */
  providerVideoId: string
  /** Stable, datastore-safe id stored in `video.videoId`, e.g. `youtube-dQw4w9WgXcQ`. */
  videoId: string
  /** Deterministic Sanity document id, e.g. `video-youtube-dQw4w9WgXcQ`. */
  documentId: string
  /** Canonical URL for this video. */
  canonicalUrl: string
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/
const VIMEO_ID = /^\d+$/
const BUNNY_LIBRARY_ID = /^\d+$/
const BUNNY_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Replaces every character Sanity rejects in document ids with `-`. */
export function toSafeIdSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, '-')
}

export function parseVideoUrl(input: string | null | undefined): ParsedVideo | null {
  const url = toUrl(input)
  if (!url) return null
  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, '')
  const segments = url.pathname.split('/').filter(Boolean)

  const youtube = parseYouTube(host, segments, url)
  if (youtube) return build('youtube', youtube, `https://www.youtube.com/watch?v=${youtube}`)

  const vimeo = parseVimeo(host, segments)
  if (vimeo) return build('vimeo', vimeo, `https://vimeo.com/${vimeo}`)

  const bunny = parseBunny(host, segments)
  if (bunny) {
    return build(
      'bunny',
      `${bunny.libraryId}/${bunny.guid}`,
      `https://iframe.mediadelivery.net/embed/${bunny.libraryId}/${bunny.guid}`,
    )
  }

  return null
}

function build(provider: VideoProvider, providerVideoId: string, canonicalUrl: string): ParsedVideo {
  const videoId = `${provider}-${toSafeIdSegment(providerVideoId)}`
  return {provider, providerVideoId, videoId, documentId: `video-${videoId}`, canonicalUrl}
}

function toUrl(input: string | null | undefined): URL | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (!trimmed) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(withScheme)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url
  } catch {
    return null
  }
}

function parseYouTube(host: string, segments: string[], url: URL): string | null {
  let candidate: string | null = null
  if (host === 'youtu.be') {
    candidate = segments[0] ?? null
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const [first, second] = segments
    if (first === 'watch') {
      candidate = url.searchParams.get('v')
    } else if (first && ['embed', 'shorts', 'live', 'v'].includes(first)) {
      candidate = second ?? null
    }
  } else {
    return null
  }
  return candidate && YOUTUBE_ID.test(candidate) ? candidate : null
}

function parseVimeo(host: string, segments: string[]): string | null {
  if (host !== 'vimeo.com' && host !== 'player.vimeo.com') return null
  // vimeo.com/{id}, vimeo.com/{id}/{unlistedHash}, player.vimeo.com/video/{id},
  // vimeo.com/channels/{name}/{id}, vimeo.com/groups/{name}/videos/{id}
  const [first, second] = segments
  let candidate: string | undefined
  if (host === 'player.vimeo.com') {
    candidate = first === 'video' ? second : undefined
  } else if (first === 'channels') {
    candidate = segments[2]
  } else if (first === 'groups') {
    candidate = segments[2] === 'videos' ? segments[3] : undefined
  } else {
    candidate = first
  }
  return candidate && VIMEO_ID.test(candidate) ? candidate : null
}

function parseBunny(host: string, segments: string[]): {libraryId: string; guid: string} | null {
  if (host !== 'iframe.mediadelivery.net' && host !== 'video.bunnycdn.com') return null
  // iframe.mediadelivery.net/{embed|play}/{libraryId}/{guid}
  const [kind, libraryId, guid] = segments
  if (kind !== 'embed' && kind !== 'play') return null
  if (!libraryId || !guid || !BUNNY_LIBRARY_ID.test(libraryId) || !BUNNY_GUID.test(guid)) return null
  return {libraryId, guid: guid.toLowerCase()}
}
