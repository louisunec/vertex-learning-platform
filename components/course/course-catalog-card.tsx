"use client";

import posthog from "posthog-js";
import { CourseCard } from "@/components/ui";
import { CourseCoverTile } from "@/components/home/course-cover-tile";
import { formatDuration, formatLevel, pluralize } from "@/lib/format";
import type { COURSES_QUERY_RESULT } from "@/sanity.types";

export interface CourseCatalogCardProps {
  course: COURSES_QUERY_RESULT[number];
  className?: string;
}

/** Stacked catalogue card for a stored course. Labels derive only from stored values. */
export function CourseCatalogCard({ course, className }: CourseCatalogCardProps) {
  return (
    <CourseCard
      layout="stacked"
      className={className}
      href={`/courses/${course.slug}`}
      onClick={() =>
        posthog.capture("course_card_clicked", {
          course_title: course.title,
          course_slug: course.slug,
          course_level: course.level,
        })
      }
      title={course.title}
      description={course.summary ?? ""}
      icon={<CourseCoverTile cover={course.coverImage} size={72} />}
      level={formatLevel(course.level)}
      duration={course.durationSeconds ? formatDuration(course.durationSeconds) : undefined}
      modules={course.moduleCount ? pluralize(course.moduleCount, "module") : undefined}
    />
  );
}
