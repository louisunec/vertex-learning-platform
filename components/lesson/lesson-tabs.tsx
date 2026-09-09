"use client";

import { useId, useState, type ReactNode } from "react";
import posthog from "posthog-js";
import { cn } from "@/lib/cn";

const TABS = [
  { key: "content", label: "Lesson Content" },
  { key: "notes", label: "Notes" },
] as const;
type Tab = (typeof TABS)[number]["key"];

export interface LessonTabsProps {
  /** "Lesson Content" panel — overview, key points, pro tip, resources. */
  content: ReactNode;
  /** "Notes" panel — the stored lesson notes; `null` when the lesson has none. */
  notes: ReactNode | null;
  lessonTitle: string;
  lessonSlug: string;
}

/** Lesson Content / Notes tab switcher. Panels are server-rendered and passed in. */
export function LessonTabs({ content, notes, lessonTitle, lessonSlug }: LessonTabsProps) {
  const [active, setActive] = useState<Tab>("content");
  const baseId = useId();

  return (
    <div>
      <div role="tablist" aria-label="Lesson" className="flex gap-8 border-b border-neutral-200">
        {TABS.map((tab) => {
          const selected = tab.key === active;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              id={`${baseId}-tab-${tab.key}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel-${tab.key}`}
              onClick={() => {
                setActive(tab.key);
                posthog.capture("lesson_tab_selected", {
                  tab: tab.label,
                  lesson_title: lessonTitle,
                  lesson_slug: lessonSlug,
                });
              }}
              className={cn(
                "-mb-px border-b-2 pb-3 font-display text-[17px] leading-6 transition-colors",
                "focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:outline-none",
                selected
                  ? "border-primary-500 text-neutral-900"
                  : "border-transparent text-neutral-500 hover:text-neutral-900",
              )}
            >
              {tab.label}
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
    </div>
  );
}
