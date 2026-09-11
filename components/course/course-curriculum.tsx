"use client";

import { useId, useState } from "react";
import Link from "next/link";
import posthog from "posthog-js";
import { Button, Icon } from "@/components/ui";
import { cn } from "@/lib/cn";
import { formatClock, formatDuration, pluralize } from "@/lib/format";

/** Trimmed, serialisable curriculum shape — the client never receives the raw query result. */
export interface CurriculumLesson {
  id: string;
  title: string;
  href: string;
  /** Derived "1.2" style position from array order. */
  position: string;
  durationSeconds: number | null;
  freePreview: boolean;
  completed: boolean;
}

export interface CurriculumModule {
  key: string;
  title: string;
  summary: string | null;
  /** Sum of the module's lesson durations; `null` when no lesson has a duration. */
  durationSeconds: number | null;
  lessons: CurriculumLesson[];
}

export interface CourseCurriculumProps {
  modules: CurriculumModule[];
  /** Grounded totals for the section header. */
  totalModules: number;
  totalDurationSeconds: number | null;
  /** How many modules are visible before "Show all". */
  initialVisible?: number;
}

export function CourseCurriculum({
  modules,
  totalModules,
  totalDurationSeconds,
  initialVisible = 6,
}: CourseCurriculumProps) {
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const baseId = useId();

  const hidden = Math.max(0, modules.length - initialVisible);
  const visible = showAll ? modules : modules.slice(0, initialVisible);

  return (
    <section aria-labelledby="course-content">
      <div className="flex flex-wrap items-baseline justify-between gap-3 px-1">
        <h2 id="course-content" className="font-display text-[26px] leading-9 font-normal text-neutral-900">
          Course Content
        </h2>
        <p className="flex items-center gap-3 text-body-lg text-neutral-500">
          <span>{pluralize(totalModules, "module")}</span>
          {totalDurationSeconds ? (
            <>
              <span aria-hidden="true" className="text-neutral-300">•</span>
              <span>{formatDuration(totalDurationSeconds)}</span>
            </>
          ) : null}
        </p>
      </div>

      <ol className="relative mt-5 rounded-lg border border-neutral-200 bg-surface shadow-sm">
        {/* Connector line threading the module numbers. */}
        {visible.length > 1 && (
          <span aria-hidden="true" className="absolute top-8 bottom-8 left-[calc(1.5rem+19px)] w-px bg-neutral-200" />
        )}
        {visible.map((mod, i) => {
          const isOpen = expanded === mod.key;
          const panelId = `${baseId}-${mod.key}`;
          return (
            <li key={mod.key} className={cn(i > 0 && "border-t border-neutral-200")}>
              <button
                type="button"
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => {
                  const next = isOpen ? null : mod.key;
                  setExpanded(next);
                  posthog.capture(isOpen ? "module_collapsed" : "module_expanded", {
                    module_title: mod.title,
                    module_position: i + 1,
                    lesson_count: mod.lessons.length,
                  });
                }}
                className="flex w-full items-center gap-5 px-6 py-4 text-left transition-colors hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:outline-none focus-visible:ring-inset"
              >
                <span className="relative z-10 flex size-10 shrink-0 items-center justify-center rounded-full border border-neutral-200 bg-surface text-body-lg text-neutral-900">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-body-lg font-medium text-neutral-900">{mod.title}</span>
                  {mod.summary && (
                    <span className="mt-0.5 block text-[13px] leading-5 text-neutral-500">{mod.summary}</span>
                  )}
                </span>
                {mod.durationSeconds ? (
                  <span className="hidden shrink-0 text-body text-neutral-700 sm:block">
                    {formatDuration(mod.durationSeconds)}
                  </span>
                ) : null}
                <Icon
                  name="chevron-down"
                  size={20}
                  className={cn("shrink-0 text-neutral-700 transition-transform", isOpen && "rotate-180")}
                />
              </button>

              <div id={panelId} hidden={!isOpen}>
                {mod.lessons.length > 0 ? (
                  <ul className="border-t border-neutral-100 bg-neutral-50/60 py-2 pr-6 pl-6 sm:pl-[84px]">
                    {mod.lessons.map((lesson) => (
                      <li key={lesson.id}>
                        <Link
                          href={lesson.href}
                          className="group flex items-center gap-4 py-2.5 text-body text-neutral-900 transition-colors hover:text-primary-500"
                          onClick={() =>
                            posthog.capture("lesson_clicked", {
                              lesson_title: lesson.title,
                              lesson_position: lesson.position,
                              module_title: mod.title,
                              free_preview: lesson.freePreview,
                              completed: lesson.completed,
                            })
                          }
                        >
                          {lesson.completed ? (
                            <Icon name="check-circle" size={18} className="shrink-0 text-success" />
                          ) : (
                            <Icon name="play" size={18} className="shrink-0 text-neutral-500 group-hover:text-primary-500" />
                          )}
                          <span className="w-8 shrink-0 tabular-nums text-neutral-500">{lesson.position}</span>
                          <span className="min-w-0 flex-1 truncate">{lesson.title}</span>
                          {lesson.freePreview && (
                            <span className="hidden shrink-0 text-small font-medium tracking-wider text-primary-500 uppercase sm:inline">
                              Free preview
                            </span>
                          )}
                          {lesson.durationSeconds != null && (
                            <span className="shrink-0 tabular-nums text-neutral-700">{formatClock(lesson.durationSeconds)}</span>
                          )}
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="border-t border-neutral-100 px-6 py-4 text-body text-neutral-500 sm:pl-[84px]">
                    No lessons published yet.
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {hidden > 0 && (
        <div className="-mt-6 flex justify-center">
          <Button
            variant="tertiary"
            className="h-12 px-6 text-[16px] shadow-sm"
            onClick={() => {
              const next = !showAll;
              setShowAll(next);
              posthog.capture("show_all_modules_clicked", {
                showing_all: next,
                total_modules: modules.length,
              });
            }}
            iconRight={<Icon name="chevron-down" size={18} className={cn("transition-transform", showAll && "rotate-180")} />}
          >
            {showAll ? "Show fewer modules" : `Show all ${pluralize(modules.length, "module")}`}
          </Button>
        </div>
      )}
    </section>
  );
}
