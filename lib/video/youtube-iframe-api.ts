/**
 * Browser-only loader for the YouTube IFrame Player API, used to observe
 * playback on the provider's own embed (VIDEO_PIPELINE §9: no custom player).
 * Minimal local types cover only what the lesson page uses.
 */

export type YouTubePlayer = {
  getCurrentTime(): number
  getDuration(): number
  /** Seeks within the provider's own player (lesson-page citations, PR-7). */
  seekTo(seconds: number, allowSeekAhead: boolean): void
  playVideo(): void
}

export type YouTubeNamespace = {
  Player: new (
    element: HTMLIFrameElement,
    options: {
      events: {
        onReady?: (event: {target: YouTubePlayer}) => void
        onStateChange: (event: {target: YouTubePlayer; data: number}) => void
      }
    },
  ) => YouTubePlayer
  PlayerState: {ENDED: number; PLAYING: number; PAUSED: number; BUFFERING: number; CUED: number}
}

declare global {
  interface Window {
    YT?: YouTubeNamespace
    onYouTubeIframeAPIReady?: () => void
  }
}

let loading: Promise<YouTubeNamespace> | null = null

/** Loads the API script once per page; resolves with the `YT` namespace. */
export function loadYouTubeIframeApi(): Promise<YouTubeNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT)
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const previous = window.onYouTubeIframeAPIReady
      window.onYouTubeIframeAPIReady = () => {
        previous?.()
        if (window.YT) resolve(window.YT)
      }
      const script = document.createElement('script')
      script.src = 'https://www.youtube.com/iframe_api'
      script.async = true
      script.onerror = () => {
        loading = null
        reject(new Error('YouTube IFrame API failed to load'))
      }
      document.head.appendChild(script)
    })
  }
  return loading
}
