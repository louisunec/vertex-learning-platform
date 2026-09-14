"use client";

import { useId, useState, type ReactNode } from "react";
import { Icon } from "@/components/ui";
import { cn } from "@/lib/cn";
import type { TutorUnavailableReason } from "@/lib/lesson/features";
import { LessonPlayerProvider } from "./lesson-player";
import { TutorPanel, TutorUnavailable } from "./tutor-panel";
import { useMediaQuery } from "./use-media-query";

/** The tutor for a signed-in learner with `lesson-integration` on: live, or why it isn't. */
export type LessonTutorSlot =
  | {
      kind: "available";
      lessonId: string;
      lessonSlug: string;
      courseSlug: string | null;
      startSeconds: number | null;
      durationSeconds: number | null;
    }
  | { kind: "unavailable"; reason: TutorUnavailableReason };

/** What the collapsed outline's disclosure says on narrow screens. */
export type OutlineSummary = { courseTitle: string; percent: number | null; moduleLabel: string | null };

/** Three columns (outline · lesson · tutor) from this width; below it the tutor opens in a drawer. */
const WIDE = "(min-width: 1280px)";

// Every lesson item sits in the centre column; the outline and tutor span every row beside it.
const CENTRE = "px-6 md:px-10 lg:col-start-2 xl:px-8";

/**
 * The lesson page's layout (`design/vertex-lessonupdate-tutor.jpg`). One CSS
 * grid places everything, so no piece remounts when the layout changes:
 *
 * - ≥1280 px: outline · lesson · tutor column (sticky beside the lesson);
 * - 1024–1279 px: outline · lesson, the tutor a drawer trigger under the video;
 * - <1024 px: one column, the outline collapsed behind a disclosure at the
 *   top (the same `LessonSidebar` instance, hidden, so no duplicate ids).
 *
 * The tutor is one `TutorPanel` whose position never changes in the tree;
 * only its `layout` prop does, so its conversation survives a resize. The
 * video sits outside every drawer and tab, so playback and progress saving
 * are never interrupted. `LessonPlayerProvider` wraps it all: the tutor and
 * the activities in `content`'s tabs share the player and the open check task.
 */
export function LessonWorkspace({
  outline,
  outlineSummary,
  header,
  video,
  content,
  footer,
  tutor,
}: {
  outline: ReactNode | null;
  outlineSummary: OutlineSummary | null;
  header: ReactNode;
  video: ReactNode;
  /** The lesson tabs: Lesson Content, Notes, and the learning activities when the learner gets them. */
  content: ReactNode;
  footer: ReactNode;
  /** Null when signed out or when `lesson-integration` is off for the learner. */
  tutor: LessonTutorSlot | null;
}) {
  const wide = useMediaQuery(WIDE);
  const layout = wide ? "column" : "drawer";
  const [outlineOpen, setOutlineOpen] = useState(false);
  const outlineId = useId();

  return (
    <LessonPlayerProvider>
      <div
        className={cn(
          "flex-1 pb-16 lg:grid lg:grid-rows-[repeat(6,auto)_1fr]",
          outline ? "lg:grid-cols-[260px_minmax(0,1fr)]" : "lg:grid-cols-[0_minmax(0,1fr)]",
          tutor &&
            (outline
              ? "xl:grid-cols-[260px_minmax(0,1fr)_clamp(340px,27vw,390px)]"
              : "xl:grid-cols-[0_minmax(0,1fr)_clamp(340px,27vw,390px)]"),
        )}
      >
        {outline && outlineSummary && (
          <button
            type="button"
            aria-expanded={outlineOpen}
            aria-controls={outlineId}
            onClick={() => setOutlineOpen((open) => !open)}
            className="flex w-full items-center gap-4 border-b border-neutral-200 bg-surface px-6 py-4 text-left focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:outline-none focus-visible:ring-inset md:px-10 lg:hidden"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-small tracking-wider text-neutral-500 uppercase">Course outline</span>
              <span className="mt-0.5 block truncate text-body-lg font-medium text-neutral-900">
                {outlineSummary.courseTitle}
              </span>
              {(outlineSummary.percent != null || outlineSummary.moduleLabel) && (
                <span className="mt-1.5 flex items-center gap-3 text-small text-neutral-500">
                  {outlineSummary.percent != null && (
                    <>
                      {/* A button holds phrasing content only, so this bar is spans; the text carries the value. */}
                      <span aria-hidden className="block h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-primary-100">
                        <span
                          className="block h-full rounded-full bg-primary-500"
                          style={{ width: `${Math.min(100, Math.max(0, outlineSummary.percent))}%` }}
                        />
                      </span>
                      <span className="whitespace-nowrap">{outlineSummary.percent}% complete</span>
                    </>
                  )}
                  {outlineSummary.moduleLabel && <span className="truncate">{outlineSummary.moduleLabel}</span>}
                </span>
              )}
            </span>
            <Icon
              name="chevron-down"
              size={20}
              className={cn("shrink-0 text-neutral-500 transition-transform", outlineOpen && "rotate-180")}
            />
          </button>
        )}

        {outline && (
          <aside
            id={outlineId}
            aria-label="Course outline"
            className={cn(
              "border-b border-neutral-200 bg-surface lg:col-start-1 lg:row-span-full lg:block lg:border-r lg:border-b-0",
              !outlineOpen && "hidden",
            )}
          >
            {outline}
          </aside>
        )}

        <div className={cn(CENTRE, "pt-9")}>{header}</div>
        <div className={cn(CENTRE, "mt-8")}>{video}</div>

        {tutor && (
          <aside
            aria-label="Lesson tutor"
            className="mt-6 px-6 md:px-10 lg:col-start-2 xl:sticky xl:top-0 xl:col-start-3 xl:row-span-full xl:mt-0 xl:flex xl:max-h-dvh xl:flex-col xl:self-start xl:py-9 xl:pr-6 xl:pl-0"
          >
            {tutor.kind === "available" ? (
              <TutorPanel
                lessonId={tutor.lessonId}
                lessonSlug={tutor.lessonSlug}
                courseSlug={tutor.courseSlug}
                startSeconds={tutor.startSeconds}
                durationSeconds={tutor.durationSeconds}
                layout={layout}
              />
            ) : (
              <TutorUnavailable reason={tutor.reason} layout={layout} />
            )}
          </aside>
        )}

        <div className={cn(CENTRE, "mt-10")}>{content}</div>

        <div className={cn(CENTRE, "mt-10 empty:hidden")}>{footer}</div>
      </div>
    </LessonPlayerProvider>
  );
}
