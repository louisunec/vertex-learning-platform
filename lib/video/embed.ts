import type {ParsedVideo} from './provider.ts'

/**
 * Provider embed sources for on-site playback. Framework-free, like
 * `provider.ts`, so the lesson page and any future search deep-link share one
 * start-time mechanism per provider (VIDEO_PIPELINE §9–10).
 */

/** Clamps a requested start position to a non-negative whole second, or `null` when unusable. */
export function toStartSeconds(value: unknown): number | null {
  const num =
    typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  if (!Number.isFinite(num) || num < 0) return null
  return Math.floor(num)
}

/** Embed URL for a parsed provider video, optionally starting at a given second. */
export function getEmbedSource(parsed: ParsedVideo, startSeconds?: number | null): string {
  const start = toStartSeconds(startSeconds)
  switch (parsed.provider) {
    case 'youtube': {
      const params = new URLSearchParams({rel: '0'})
      if (start) params.set('start', String(start))
      return `https://www.youtube-nocookie.com/embed/${parsed.providerVideoId}?${params}`
    }
    case 'vimeo':
      return `https://player.vimeo.com/video/${parsed.providerVideoId}${start ? `#t=${start}s` : ''}`
    case 'bunny':
      // providerVideoId is `libraryId/guid`; Bunny's embed accepts `t` in seconds.
      return `https://iframe.mediadelivery.net/embed/${parsed.providerVideoId}${start ? `?t=${start}` : ''}`
  }
}
