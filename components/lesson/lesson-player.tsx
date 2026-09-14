"use client";

import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import type { YouTubePlayer } from "@/lib/video/youtube-iframe-api";

/**
 * Shares the lesson's provider player with the tutor panel and the check
 * (development plan §5 PR-7): the real playhead for tutor questions, in-place
 * seeking for citations, and the completion signal for the practice
 * invitation. `VideoEmbed` registers the YouTube player once it is ready;
 * without a registered player every method degrades (no position, no seek),
 * and callers fall back to the page's start second or a `?t=` link.
 */
export type LessonPlayer = {
  register(player: YouTubePlayer, element: HTMLElement): () => void;
  notifyCompleted(): void;
  /** Current playhead in seconds, or null before the player is ready. */
  getPosition(): number | null;
  /** Seeks and plays in place; false when there is no ready player. */
  seekTo(seconds: number): boolean;
  /** Called once playback first reaches the completion milestone (90% or the end). */
  onCompleted(listener: () => void): () => void;
};

const LessonPlayerContext = createContext<LessonPlayer | null>(null);

export function LessonPlayerProvider({ children }: { children: ReactNode }) {
  const player = useRef<{ player: YouTubePlayer; element: HTMLElement } | null>(null);
  const listeners = useRef(new Set<() => void>());

  const value = useMemo<LessonPlayer>(
    () => ({
      register(next, element) {
        const entry = { player: next, element };
        player.current = entry;
        return () => {
          if (player.current === entry) player.current = null;
        };
      },
      notifyCompleted() {
        for (const listener of listeners.current) listener();
      },
      getPosition() {
        try {
          const seconds = player.current?.player.getCurrentTime();
          return typeof seconds === "number" && Number.isFinite(seconds) ? Math.max(0, seconds) : null;
        } catch {
          return null;
        }
      },
      seekTo(seconds) {
        const current = player.current;
        if (!current) return false;
        try {
          current.player.seekTo(seconds, true);
          current.player.playVideo();
        } catch {
          return false;
        }
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        current.element.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
        return true;
      },
      onCompleted(listener) {
        listeners.current.add(listener);
        return () => listeners.current.delete(listener);
      },
    }),
    [],
  );

  return <LessonPlayerContext.Provider value={value}>{children}</LessonPlayerContext.Provider>;
}

/** The lesson's player bridge, or null outside `LessonPlayerProvider` (learning features off). */
export function useLessonPlayer(): LessonPlayer | null {
  return useContext(LessonPlayerContext);
}
