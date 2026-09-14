"use client";

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import posthog from "posthog-js";
import { cn } from "@/lib/cn";
import { ACTIVITY_EMPTY_TEXT, activityTabs, initialActivity, type ActivityKey } from "@/lib/lesson/activities";

/**
 * The lesson's learning activities, each rendered by the PR that owns it and
 * passed in already resolved for this learner and lesson: `null` means the
 * activity isn't available here (a flag is off, or the lesson has no approved
 * task for it), and its tab says so instead of rendering it.
 *
 * - `quickCheck`: PR-7 `LessonCheck`, when `features.check`;
 * - `explainBack`: PR-8 `ExplainBack` (embedded), when `resolveExplainTask` returns a task;
 * - `submitImplementation`: PR-12 `SubmissionReview` (embedded), when `resolveSubmissionTask` returns a task.
 */
export type LessonActivitySlots = {
  quickCheck: ReactNode | null;
  explainBack: ReactNode | null;
  submitImplementation: ReactNode | null;
};

/**
 * Tabs over all three activities, in a fixed order, with the first available
 * one selected; an unavailable tab stays selectable and shows one line saying
 * there's nothing here yet. Every panel stays mounted (`hidden`), so an open
 * question, a draft explanation, or pasted code survives switching tabs. Each
 * panel is a size container, so an activity lays itself out by the column's
 * width, not the viewport's. Arrow keys, Home and End move between tabs.
 */
export function LessonActivities({
  activities,
  lessonTitle,
  lessonSlug,
}: {
  activities: LessonActivitySlots;
  lessonTitle: string;
  lessonSlug: string;
}) {
  const all = activityTabs(activities);
  const [selected, setSelected] = useState<ActivityKey | null>(null);
  const tabs = useRef(new Map<ActivityKey, HTMLButtonElement>());
  const baseId = useId();

  const active = selected ?? initialActivity(all);

  function select(key: ActivityKey, label: string) {
    setSelected(key);
    posthog.capture("lesson_tab_selected", { tab: label, lesson_title: lessonTitle, lesson_slug: lessonSlug });
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = all.length - 1;
    const target =
      event.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : null;
    if (target === null) return;
    event.preventDefault();
    const next = all[target];
    select(next.key, next.label);
    tabs.current.get(next.key)?.focus();
  }

  return (
    <section className="rounded-[20px] border border-neutral-200 bg-surface">
      <div
        role="tablist"
        aria-label="Learning activities"
        className="flex gap-8 overflow-x-auto border-b border-neutral-200 px-6"
      >
        {all.map((activity, index) => {
          const isActive = activity.key === active;
          return (
            <button
              key={activity.key}
              ref={(element) => {
                if (element) tabs.current.set(activity.key, element);
                else tabs.current.delete(activity.key);
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${activity.key}`}
              aria-selected={isActive}
              aria-controls={`${baseId}-panel-${activity.key}`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => select(activity.key, activity.label)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={cn(
                "-mb-px shrink-0 border-b-2 pt-4 pb-3 font-display text-[17px] leading-6 whitespace-nowrap transition-colors",
                "focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:outline-none",
                isActive
                  ? "border-primary-500 text-primary-500"
                  : "border-transparent text-neutral-500 hover:text-neutral-900",
              )}
            >
              {activity.label}
            </button>
          );
        })}
      </div>

      {all.map((activity) => (
        <div
          key={activity.key}
          role="tabpanel"
          id={`${baseId}-panel-${activity.key}`}
          aria-labelledby={`${baseId}-tab-${activity.key}`}
          hidden={activity.key !== active}
          // Learner answers, explanations and code stay out of session replay, whatever the slot renders.
          className="ph-no-capture @container px-6 pt-5 pb-6"
        >
          {activity.available ? (
            activities[activity.key]
          ) : (
            <p className="text-body text-neutral-700">{ACTIVITY_EMPTY_TEXT[activity.key]}</p>
          )}
        </div>
      ))}
    </section>
  );
}
