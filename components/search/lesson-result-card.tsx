"use client";

import Link from "next/link";
import { Badge, Card, Icon } from "@/components/ui";
import { SearchCourseIcon } from "./search-course-icon";
import type { LessonSearchResult } from "@/lib/search/schema";

/**
 * Grounded lesson-topic match row. Renders stored data only: the tile lists the
 * lesson's stored key points, and the module label is derived from the
 * order-based curriculum position (`"5.1"` → `Module 5`).
 */
export function LessonResultCard({ result, onOpen }: { result: LessonSearchResult; onOpen?: () => void }) {
  const keyPoints = result.keyPoints.slice(0, 3);
  const moduleNumber = result.course?.position?.split(".")[0] ?? null;

  return (
    <Link
      href={result.href}
      className="block rounded-lg focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:outline-none"
      onClick={onOpen}
    >
      <Card className="flex flex-col gap-4 p-4 transition-colors hover:border-primary-400 md:flex-row md:gap-8">
        <div className="relative flex aspect-video shrink-0 gap-3 overflow-hidden rounded-md border border-neutral-200 bg-canvas p-4 md:w-[275px]">
          {result.course ? (
            <SearchCourseIcon coverImageUrl={result.course.coverImageUrl} size={22} className="mt-0.5" />
          ) : (
            <Icon name="document" size={22} className="mt-0.5 text-neutral-700" aria-hidden />
          )}
          {keyPoints.length > 0 && (
            <ul className="flex min-w-0 flex-col gap-2 text-body-lg text-neutral-700">
              {keyPoints.map((point) => (
                <li key={point} className="flex gap-2">
                  <span aria-hidden="true" className="text-neutral-500">
                    ·
                  </span>
                  <span className="truncate">{point}</span>
                </li>
              ))}
            </ul>
          )}
          <span
            aria-hidden="true"
            className="absolute right-3 bottom-3 flex size-7 items-center justify-center rounded-full bg-neutral-700"
          >
            <Icon name="check-circle" size={18} className="text-white" />
          </span>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-start justify-between gap-4">
            {result.course && (
              <span className="flex min-w-0 items-center gap-2.5">
                <SearchCourseIcon coverImageUrl={result.course.coverImageUrl} />
                <span className="truncate text-body-lg text-neutral-700">{result.course.title}</span>
              </span>
            )}
            <Badge variant="lesson" className="ml-auto">
              lesson
            </Badge>
          </div>

          <h3 className="mt-3 text-[19px] leading-7 font-semibold text-neutral-900">{result.title}</h3>
          {result.description && (
            <p className="mt-1.5 text-body-lg leading-6 text-neutral-500">{result.description}</p>
          )}

          <div className="mt-auto flex flex-wrap items-center justify-between gap-x-6 gap-y-2 pt-4">
            {moduleNumber && <span className="text-body-lg text-neutral-700">Module {moduleNumber}</span>}
            <span className="ml-auto inline-flex items-center gap-2 text-body-lg font-medium text-primary-500">
              View lesson
              <Icon name="external-link" size={16} aria-hidden />
              <Icon name="chevron-right" size={16} aria-hidden />
            </span>
          </div>
        </div>
      </Card>
    </Link>
  );
}
