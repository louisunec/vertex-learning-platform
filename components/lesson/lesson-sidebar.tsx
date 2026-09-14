"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import posthog from "posthog-js";
import { Icon, ProgressBar } from "@/components/ui";
import { cn } from "@/lib/cn";
import { formatDuration } from "@/lib/format";

/** Trimmed, serialisable curriculum shape — the client never receives the raw query result. */
export interface SidebarLesson {
  id: string;
  title: string;
  href: string;
  durationSeconds: number | null;
  completed: boolean;
  current: boolean;
}

export interface SidebarModule {
  key: string;
  title: string;
  /** Sum of the module's lesson durations; `null` when no lesson has a duration. */
  durationSeconds: number | null;
  /** All resolvable lessons in the module are completed. */
  completed: boolean;
  lessons: SidebarLesson[];
}

export interface LessonSidebarProps {
  courseTitle: string;
  courseHref: string;
  coverImageUrl: string | null;
  /** Shown only for signed-in learners; `null` hides the progress row. */
  percent: number | null;
  modules: SidebarModule[];
  /** One-based module number of the current lesson, `null` when unknown. */
  currentModuleNumber: number | null;
  currentModuleKey: string | null;
}

/** Course curriculum rail for the lesson page: back link, course tile, module accordion. */
export function LessonSidebar({
  courseTitle,
  courseHref,
  coverImageUrl,
  percent,
  modules,
  currentModuleNumber,
  currentModuleKey,
}: LessonSidebarProps) {
  const [expanded, setExpanded] = useState<string | null>(currentModuleKey);

  return (
    <div className="flex flex-col">
      <div className="border-b border-neutral-100 px-6 py-6">
        <Link
          href={courseHref}
          className="inline-flex items-center gap-2 text-body font-medium text-primary-500 transition-colors hover:text-primary-600"
        >
          <Icon name="arrow-left" size={16} />
          Back to course
        </Link>

        <div className="mt-5 flex items-center gap-4">
          <div className="relative size-12 shrink-0 overflow-hidden rounded-lg bg-black">
            {coverImageUrl && <Image src={coverImageUrl} alt="" fill sizes="48px" className="object-cover" />}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-body-lg font-medium text-neutral-900">{courseTitle}</p>
            {percent != null && (
              <div className="mt-1.5 flex items-center gap-2">
                <ProgressBar value={percent} showLabel={false} aria-label="Course progress" className="w-16" />
                <span className="text-small whitespace-nowrap text-neutral-500">{percent}% complete</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {currentModuleNumber != null && modules.length > 0 && (
        <p className="border-b border-neutral-100 px-6 py-4 text-body font-medium text-neutral-900">
          Module {currentModuleNumber} of {modules.length}
        </p>
      )}

      <ol>
        {modules.map((mod, i) => {
          const isOpen = expanded === mod.key;
          const isCurrent = mod.key === currentModuleKey;
          const panelId = `lesson-sidebar-${mod.key}`;
          return (
            <li key={mod.key} className={cn(i > 0 && "border-t border-neutral-100")}>
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
                    source: "lesson_sidebar",
                  });
                }}
                className={cn(
                  "flex w-full items-center gap-4 px-6 py-4 text-left transition-colors hover:bg-neutral-50",
                  "focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:outline-none focus-visible:ring-inset",
                  isCurrent && "bg-primary-100/40",
                )}
              >
                <span
                  className={cn(
                    "flex size-8 shrink-0 items-center justify-center rounded-full text-body",
                    isCurrent
                      ? "bg-primary-500 font-medium text-on-primary"
                      : "border border-neutral-200 bg-surface text-neutral-900",
                  )}
                >
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  {/* Full title, wrapping as needed; the row grows and the number and chevron stay centred on it. */}
                  <span className="block text-body font-medium break-words text-neutral-900">{mod.title}</span>
                  {mod.durationSeconds != null && (
                    <span className="mt-0.5 block text-small text-neutral-500">
                      {formatDuration(mod.durationSeconds)}
                    </span>
                  )}
                </span>
                {mod.completed ? (
                  <Icon name="check-circle" size={18} className="shrink-0 text-primary-500" />
                ) : (
                  <Icon
                    name="chevron-down"
                    size={16}
                    className={cn("shrink-0 text-neutral-500 transition-transform", isOpen && "rotate-180")}
                  />
                )}
              </button>

              <div id={panelId} hidden={!isOpen}>
                {mod.lessons.length > 0 && (
                  <ul className="pb-3">
                    {mod.lessons.map((lesson, lessonIndex) => (
                      <li key={lesson.id}>
                        <Link
                          href={lesson.href}
                          aria-current={lesson.current ? "page" : undefined}
                          className={cn(
                            "group flex items-center gap-3 py-2.5 pr-5 pl-6 transition-colors",
                            lesson.current ? "bg-primary-100/60" : "hover:bg-neutral-50",
                          )}
                          onClick={() =>
                            posthog.capture("lesson_clicked", {
                              lesson_title: lesson.title,
                              module_title: mod.title,
                              completed: lesson.completed,
                              source: "lesson_sidebar",
                            })
                          }
                        >
                          {/* Lesson numbers come from the module's authored order. */}
                          <span
                            aria-hidden="true"
                            className={cn(
                              "flex size-8 shrink-0 items-center justify-center rounded-full text-small",
                              lesson.current
                                ? "bg-primary-500 font-medium text-on-primary"
                                : "border border-neutral-300 text-neutral-700",
                            )}
                          >
                            {lessonIndex + 1}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span
                              className={cn(
                                "line-clamp-2 block text-body",
                                lesson.current
                                  ? "font-medium text-neutral-900"
                                  : "text-neutral-700 group-hover:text-neutral-900",
                              )}
                            >
                              {lesson.title}
                            </span>
                            <span
                              className={cn(
                                "mt-0.5 block text-small",
                                lesson.current ? "text-primary-500" : "text-neutral-500",
                              )}
                            >
                              {lesson.current
                                ? "Now playing"
                                : lesson.durationSeconds != null
                                  ? formatDuration(lesson.durationSeconds)
                                  : null}
                            </span>
                          </span>
                          {lesson.current ? (
                            <Icon name="play" size={26} filled className="shrink-0 text-primary-500" />
                          ) : lesson.completed ? (
                            <>
                              <Icon name="check-circle" size={20} className="shrink-0 text-primary-500" />
                              <span className="sr-only">Completed</span>
                            </>
                          ) : null}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
