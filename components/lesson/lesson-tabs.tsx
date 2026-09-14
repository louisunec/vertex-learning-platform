"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import posthog from "posthog-js";
import { cn } from "@/lib/cn";
import { ACTIVITY_EMPTY_TEXT, activityTabs, type ActivityKey, type LessonActivitySlots } from "@/lib/lesson/activities";
import { useLessonPlayer } from "./lesson-player";

type Tab = "content" | "notes" | ActivityKey;

export interface LessonTabsProps {
  /** "Lesson Content" panel — overview, key points, pro tip, resources. */
  content: ReactNode;
  /** "Notes" panel — the stored lesson notes; `null` when the lesson has none. */
  notes: ReactNode | null;
  /** The learning activities, or null when the learner doesn't get them (signed out, or `lesson-integration` off). */
  activities?: LessonActivitySlots | null;
  lessonTitle: string;
  lessonSlug: string;
}

/**
 * One tab row: Lesson Content and Notes, then (when `activities` is given) Quick
 * check, Explain it back and Submit implementation. Lesson Content opens first.
 * Every panel stays mounted (`hidden`), so an open question, a draft
 * explanation, or pasted code survives switching tabs. An activity with nothing
 * on this lesson shows one "not yet" line; activity panels are size containers
 * and stay out of session replay. Arrow keys, Home and End move between tabs.
 * After the video completes, a dot marks Quick check until it's opened, since
 * the check's own invitation sits in its panel.
 */
export function LessonTabs({ content, notes, activities = null, lessonTitle, lessonSlug }: LessonTabsProps) {
  const activityList = activities ? activityTabs(activities) : [];
  const tabs: Array<{ key: Tab; label: string }> = [
    { key: "content", label: "Lesson Content" },
    { key: "notes", label: "Notes" },
    ...activityList,
  ];
  const [active, setActive] = useState<Tab>("content");
  const [checkReady, setCheckReady] = useState(false);
  const buttons = useRef(new Map<Tab, HTMLButtonElement>());
  const activeRef = useRef(active);
  const baseId = useId();
  const player = useLessonPlayer();
  const hasCheck = activities?.quickCheck != null;

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    if (!player || !hasCheck) return;
    return player.onCompleted(() => {
      if (activeRef.current !== "quickCheck") setCheckReady(true);
    });
  }, [player, hasCheck]);

  function select(tab: { key: Tab; label: string }) {
    setActive(tab.key);
    if (tab.key === "quickCheck") setCheckReady(false);
    posthog.capture("lesson_tab_selected", { tab: tab.label, lesson_title: lessonTitle, lesson_slug: lessonSlug });
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = tabs.length - 1;
    const target =
      event.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : null;
    if (target === null) return;
    event.preventDefault();
    select(tabs[target]);
    buttons.current.get(tabs[target].key)?.focus();
  }

  return (
    <div>
      {/* The divider is an inset shadow, not a border: the row scrolls sideways, and a border would clip the selected underline. */}
      <div
        role="tablist"
        aria-label="Lesson"
        className="flex gap-8 overflow-x-auto shadow-[inset_0_-1px_0_var(--color-neutral-200)]"
      >
        {tabs.map((tab, index) => {
          const selected = tab.key === active;
          const dot = tab.key === "quickCheck" && checkReady && !selected;
          return (
            <button
              key={tab.key}
              ref={(element) => {
                if (element) buttons.current.set(tab.key, element);
                else buttons.current.delete(tab.key);
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${tab.key}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel-${tab.key}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => select(tab)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={cn(
                "inline-flex shrink-0 items-center gap-2 border-b-2 pb-3 font-display text-[17px] leading-6 whitespace-nowrap transition-colors",
                "focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:outline-none focus-visible:ring-inset",
                selected
                  ? "border-primary-500 text-neutral-900"
                  : "border-transparent text-neutral-500 hover:text-neutral-900",
              )}
            >
              {tab.label}
              {dot && (
                <>
                  <span aria-hidden className="size-2 rounded-full bg-primary-500" />
                  <span className="sr-only">, questions ready</span>
                </>
              )}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`${baseId}-panel-content`}
        aria-labelledby={`${baseId}-tab-content`}
        hidden={active !== "content"}
        className="pt-8"
      >
        {content}
      </div>
      <div
        role="tabpanel"
        id={`${baseId}-panel-notes`}
        aria-labelledby={`${baseId}-tab-notes`}
        hidden={active !== "notes"}
        className="pt-8"
      >
        {notes ?? <p className="text-[15px] leading-7 text-neutral-500">No notes for this lesson.</p>}
      </div>
      {activities &&
        activityList.map((activity) => (
          <div
            key={activity.key}
            role="tabpanel"
            id={`${baseId}-panel-${activity.key}`}
            aria-labelledby={`${baseId}-tab-${activity.key}`}
            hidden={activity.key !== active}
            // Learner answers, explanations and code stay out of session replay, whatever the slot renders.
            className="ph-no-capture @container pt-8"
          >
            {activity.available ? (
              activities[activity.key]
            ) : (
              <p className="text-body text-neutral-700">{ACTIVITY_EMPTY_TEXT[activity.key]}</p>
            )}
          </div>
        ))}
    </div>
  );
}
