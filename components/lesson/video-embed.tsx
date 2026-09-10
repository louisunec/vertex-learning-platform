"use client";

import { useEffect, useRef } from "react";
import posthog from "posthog-js";
import type { VideoProvider } from "@/lib/video/provider";
import { COMPLETION_MILESTONE, reachedMilestones, type WatchDepthMilestone } from "@/lib/video/watch-depth";
import { loadYouTubeIframeApi, type YouTubePlayer } from "@/lib/video/youtube-iframe-api";

/** Where playback starts: a `?t=` deep link, the stored resume position, or 0. */
export type StartSource = "deeplink" | "resume" | "beginning";

export interface VideoTracking {
  provider: VideoProvider;
  lessonSlug: string;
  courseSlug: string | null;
  startSeconds: number | null;
  startSource: StartSource;
}

/**
 * Provider-hosted player (VIDEO_PIPELINE §9: embeds only, no custom player).
 * `src` comes from `getEmbedSource`, which already encodes the start second in
 * the provider's supported mechanism. YouTube embeds also report play and
 * watch-depth analytics through the IFrame Player API; other providers only play.
 */
export function VideoEmbed({ src, title, tracking }: { src: string; title: string; tracking: VideoTracking }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // Refs survive Strict Mode's double effect, keeping each event once per mount.
  const played = useRef(false);
  const reported = useRef(new Set<WatchDepthMilestone>());
  const { provider, lessonSlug, courseSlug, startSeconds, startSource } = tracking;

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || provider !== "youtube") return;

    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const base = {
      lesson_slug: lessonSlug,
      course_slug: courseSlug,
      provider,
      start_seconds: startSeconds,
      start_source: startSource,
    };

    const stopPolling = () => {
      if (timer) clearInterval(timer);
      timer = null;
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
          // Analytics-only: no progress write path exists yet, so this does not mark the lesson complete.
          posthog.capture("lesson_completed", { ...base, completion_basis: "watch_depth_90" });
        }
      }
    };

    loadYouTubeIframeApi()
      .then((YT) => {
        if (cancelled) return;
        new YT.Player(iframe, {
          events: {
            onStateChange: ({ target: player, data }) => {
              if (cancelled) return;
              if (data === YT.PlayerState.PLAYING) {
                if (!played.current) {
                  played.current = true;
                  posthog.capture("video_played", { ...base, duration_seconds: Math.round(player.getDuration()) });
                }
                timer ??= setInterval(() => checkDepth(player, false), 1000);
              } else {
                stopPolling();
                if (data === YT.PlayerState.ENDED) checkDepth(player, true);
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
    };
  }, [provider, lessonSlug, courseSlug, startSeconds, startSource]);

  return (
    <div className="overflow-hidden rounded-[20px] bg-neutral-900 shadow-sm">
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
