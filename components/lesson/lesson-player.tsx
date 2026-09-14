"use client";

import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { YouTubePlayer } from "@/lib/video/youtube-iframe-api";

/** The check question the learner is on, if any: tutor help on it counts as help on that task. */
export type ActiveTask = { taskInstanceId: string; label: string } | null;

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
/**
 * The open check question, shared between the check (in the activity tabs)
 * and the tutor (in its own column or drawer) so tutor help is recorded
 * against that task, as the help policy requires. The setter has its own,
 * stable context so reporting never re-renders the reporter.
 */
const ActiveTaskContext = createContext<ActiveTask>(null);
const ReportActiveTaskContext = createContext<(task: ActiveTask) => void>(() => {});

export function LessonPlayerProvider({ children }: { children: ReactNode }) {
  const player = useRef<{ player: YouTubePlayer; element: HTMLElement } | null>(null);
  const listeners = useRef(new Set<() => void>());
  const [activeTask, setActiveTask] = useState<ActiveTask>(null);

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

  return (
    <LessonPlayerContext.Provider value={value}>
      <ReportActiveTaskContext.Provider value={setActiveTask}>
        <ActiveTaskContext.Provider value={activeTask}>{children}</ActiveTaskContext.Provider>
      </ReportActiveTaskContext.Provider>
    </LessonPlayerContext.Provider>
  );
}

/** The lesson's player bridge, or null outside `LessonPlayerProvider`. */
export function useLessonPlayer(): LessonPlayer | null {
  return useContext(LessonPlayerContext);
}

/** The check question the learner has open, for the tutor. */
export function useActiveTask(): ActiveTask {
  return useContext(ActiveTaskContext);
}

/** Reports the open check question (or null once it is graded or closed). */
export function useReportActiveTask(): (task: ActiveTask) => void {
  return useContext(ReportActiveTaskContext);
}
