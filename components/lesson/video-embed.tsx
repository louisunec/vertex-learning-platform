"use client";

import { useEffect, useRef } from "react";
import posthog from "posthog-js";
import type { VideoProvider } from "@/lib/video/provider";
import { SEEK_TRACKING_FLAG, SeekTracker, type Seek } from "@/lib/video/seek";
import { COMPLETION_MILESTONE, reachedMilestones, type WatchDepthMilestone } from "@/lib/video/watch-depth";
import { loadYouTubeIframeApi, type YouTubePlayer } from "@/lib/video/youtube-iframe-api";
import { useLessonPlayer } from "./lesson-player";

/** Where playback starts: a `?t=` deep link, the stored resume position, or 0. */
export type StartSource = "deeplink" | "resume" | "beginning";

export interface VideoTracking {
  provider: VideoProvider;
  lessonId: string;
  lessonSlug: string;
  courseSlug: string | null;
  startSeconds: number | null;
  startSource: StartSource;
  /** Signed-in learners only: save the resume position and completion through `/api/progress`. */
  saveProgress: boolean;
  /** Stable video id (`parseVideoUrl`), so editorial signals key replays by the exact video (PR-10). */
  videoId: string | null;
}

/**
 * Whether this page view reports `video_seeked` (editorial replay signals,
 * PR-10): the `editorial-signals` flag as posthog-js already loaded it in the
 * browser. Fails closed when flags have not loaded or PostHog is blocked.
 */
function seekTrackingEnabled(): boolean {
  try {
    return posthog.isFeatureEnabled(SEEK_TRACKING_FLAG, { send_event: false }) === true;
  } catch {
    return false;
  }
}

/** Seconds of continuous playback between resume-position saves. */
const PROGRESS_SAVE_INTERVAL_SECONDS = 15;

/** Sends one progress save; `keepalive` lets it finish while the page unloads. Failures never affect playback. */
function postProgress(lessonId: string, positionSeconds: number, completed: boolean) {
  void fetch("/api/progress", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lessonId, positionSeconds: Math.max(0, positionSeconds), ...(completed ? { completed } : {}) }),
    keepalive: true,
  }).catch((error) => console.warn("[progress] save failed:", error));
}

/**
 * Provider-hosted player (VIDEO_PIPELINE §9: embeds only, no custom player).
 * `src` comes from `getEmbedSource`, which already encodes the start second in
 * the provider's supported mechanism. YouTube embeds also report play and
 * watch-depth analytics through the IFrame Player API and, for signed-in
 * learners, save progress (on pause, every 15 s of playback, at the 90%
 * completion milestone, on end, and when the page is hidden); other
 * providers only play. Inside `LessonPlayerProvider` (PR-7) the YouTube
 * player is also shared with the tutor and check, and the completion
 * milestone is announced to them.
 */
export function VideoEmbed({ src, title, tracking }: { src: string; title: string; tracking: VideoTracking }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // Refs survive Strict Mode's double effect, keeping each event once per mount.
  const played = useRef(false);
  // Decided once per view at the first play, and reported on `video_played`, so replay shares use a matching denominator.
  const seekTracking = useRef<boolean | null>(null);
  const reported = useRef(new Set<WatchDepthMilestone>());
  const bridge = useLessonPlayer();
  const { provider, lessonId, lessonSlug, courseSlug, startSeconds, startSource, saveProgress, videoId } = tracking;

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || provider !== "youtube") return;

    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let activePlayer: YouTubePlayer | null = null;
    let unregister: (() => void) | null = null;
    let completed = false;
    let secondsSinceSave = 0;
    const base = {
      lesson_slug: lessonSlug,
      course_slug: courseSlug,
      lesson_id: lessonId,
      video_id: videoId,
      provider,
      start_seconds: startSeconds,
      start_source: startSource,
    };
    // Seeks versus normal playback and replays (lib/video/seek.ts); citation jumps are labelled, not counted.
    let seeks: SeekTracker | null = null;
    const startSeekTracking = () => {
      seekTracking.current ??= seekTrackingEnabled();
      if (seekTracking.current) seeks ??= new SeekTracker(() => bridge?.lastPageSeek() ?? null);
    };
    const reportSeek = (seek: Seek | null, player: YouTubePlayer) => {
      if (!seek) return;
      posthog.capture("video_seeked", {
        ...base,
        from_seconds: seek.fromSeconds,
        to_seconds: seek.toSeconds,
        seek_kind: seek.kind,
        seek_origin: seek.origin,
        duration_seconds: Math.round(player.getDuration()),
      });
    };
    const observeSeek = (player: YouTubePlayer, playing: boolean) => {
      if (!seeks) return;
      try {
        reportSeek(seeks.sample(player.getCurrentTime(), Date.now(), { playing, rate: player.getPlaybackRate() }), player);
      } catch {
        // Analytics only; playback is unaffected.
      }
    };

    const stopPolling = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };

    const save = (position: number) => {
      if (!saveProgress || !played.current) return;
      secondsSinceSave = 0;
      postProgress(lessonId, position, completed);
    };

    const checkDepth = (player: YouTubePlayer, ended: boolean) => {
      const duration = player.getDuration();
      const position = ended ? duration : player.getCurrentTime();
      const milestones = reachedMilestones({
        positionSeconds: position,
        durationSeconds: duration,
        startSeconds,
        reported: reported.current,
      });
      for (const milestone of milestones) {
        reported.current.add(milestone);
        posthog.capture("video_watch_depth", {
          ...base,
          depth_percent: milestone,
          position_seconds: Math.floor(position),
          duration_seconds: Math.round(duration),
        });
        if (milestone === COMPLETION_MILESTONE) {
          posthog.capture("lesson_completed", { ...base, completion_basis: "watch_depth_90" });
          completed = true;
          save(position);
          bridge?.notifyCompleted();
        }
      }
    };

    const tick = (player: YouTubePlayer) => {
      observeSeek(player, true);
      checkDepth(player, false);
      secondsSinceSave += 1;
      if (secondsSinceSave >= PROGRESS_SAVE_INTERVAL_SECONDS) save(player.getCurrentTime());
    };

    const onPageHide = () => {
      if (activePlayer) save(activePlayer.getCurrentTime());
    };
    window.addEventListener("pagehide", onPageHide);

    loadYouTubeIframeApi()
      .then((YT) => {
        if (cancelled) return;
        new YT.Player(iframe, {
          events: {
            onReady: ({ target }) => {
              if (!cancelled && bridge) unregister = bridge.register(target, iframe);
            },
            onStateChange: ({ target: player, data }) => {
              if (cancelled) return;
              activePlayer = player;
              // Before the first play the embed reports 0, not the `?t=` or resume start: no baseline yet.
              if (played.current || data === YT.PlayerState.PLAYING) {
                startSeekTracking();
                observeSeek(player, data === YT.PlayerState.PLAYING);
              }
              if (data === YT.PlayerState.PLAYING) {
                if (!played.current) {
                  played.current = true;
                  posthog.capture("video_played", {
                    ...base,
                    duration_seconds: Math.round(player.getDuration()),
                    seek_tracking: seekTracking.current === true,
                  });
                }
                timer ??= setInterval(() => tick(player), 1000);
              } else {
                stopPolling();
                if (data === YT.PlayerState.ENDED) {
                  if (seeks) reportSeek(seeks.flush(), player);
                  checkDepth(player, true);
                  save(player.getDuration());
                } else if (data === YT.PlayerState.PAUSED) {
                  save(player.getCurrentTime());
                }
              }
            },
          },
        });
      })
      .catch((error) => {
        // Tracking only; the embed still plays.
        console.error("[analytics] YouTube player tracking unavailable:", error);
      });

    return () => {
      cancelled = true;
      stopPolling();
      unregister?.();
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [provider, lessonId, lessonSlug, courseSlug, startSeconds, startSource, saveProgress, videoId, bridge]);

  return (
    <div className="overflow-hidden rounded-[20px] bg-black shadow-sm">
      <iframe
        ref={iframeRef}
        src={src}
        title={title}
        className="aspect-video w-full"
        allow="autoplay; fullscreen; picture-in-picture"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
      />
    </div>
  );
}
