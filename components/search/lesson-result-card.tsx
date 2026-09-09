"use client";

import Link from "next/link";
import posthog from "posthog-js";
import { Badge, Card, Icon } from "@/components/ui";
import { formatDuration } from "@/lib/format";
import type { LessonSearchResult } from "@/lib/search/schema";

/** Grounded lesson-topic match card. Renders stored data only. */
export function LessonResultCard({ result }: { result: LessonSearchResult }) {
  const meta: string[] = [];
  if (result.course) {
    meta.push(result.course.title);
    if (result.course.position) meta.push(`Lesson ${result.course.position}`);
  }
  if (result.durationSeconds) meta.push(formatDuration(result.durationSeconds));
  if (result.freePreview) meta.push("Free preview");

  return (
    <Link
      href={result.href}
      className="block focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:outline-none"
      onClick={() =>
        posthog.capture("search_result_clicked", {
          result_type: "lesson",
          lesson_slug: result.slug,
          course_slug: result.course?.slug ?? null,
        })
      }
    >
      <Card className="flex flex-col gap-3 transition-colors hover:border-primary-400">
        <Badge variant="lesson">lesson</Badge>
        <div className="flex flex-col gap-1.5">
          <h3 className="text-body-lg font-semibold text-neutral-900">{result.title}</h3>
          {result.description && <p className="text-small leading-5 text-neutral-500">{result.description}</p>}
        </div>
        {meta.length > 0 && (
          <ul className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 text-small text-neutral-500">
            {meta.map((item) => (
              <li key={item} className="inline-flex items-center gap-1.5">
                <Icon name="chevron-right" size={12} className="text-neutral-400" aria-hidden />
                {item}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Link>
  );
}
