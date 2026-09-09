"use client";

import posthog from "posthog-js";
import { Button, Icon } from "@/components/ui";

export interface CourseHeroActionsProps {
  courseTitle: string;
  courseSlug: string;
  ctaHref: string | null;
  ctaLabel: string;
}

/**
 * Client component that renders the primary CTA and Bookmark buttons on the
 * course detail page. Split from CourseHero so event capture stays out of the
 * server component tree.
 */
export function CourseHeroActions({
  courseTitle,
  courseSlug,
  ctaHref,
  ctaLabel,
}: CourseHeroActionsProps) {
  const isStarting = ctaLabel === "Start Learning";

  const handleCtaClick = () => {
    posthog.capture(isStarting ? "course_started" : "course_continued", {
      course_title: courseTitle,
      course_slug: courseSlug,
    });
  };

  const handleBookmarkClick = () => {
    posthog.capture("course_bookmarked", {
      course_title: courseTitle,
      course_slug: courseSlug,
    });
  };

  return (
    <div className="mt-8 flex flex-wrap items-center gap-4">
      {ctaHref ? (
        <Button
          href={ctaHref}
          className="h-14 px-6 text-[17px] shadow-sm"
          iconRight={<Icon name="arrow-right" size={20} />}
          onClick={handleCtaClick}
        >
          {ctaLabel}
        </Button>
      ) : (
        <Button
          disabled
          className="h-14 px-6 text-[17px]"
          iconRight={<Icon name="arrow-right" size={20} />}
        >
          {ctaLabel}
        </Button>
      )}
      {/* Presentational: bookmarking has no backend yet. */}
      <Button
        variant="tertiary"
        className="h-14 px-6 text-[17px]"
        iconLeft={<Icon name="bookmark" size={20} />}
        onClick={handleBookmarkClick}
      >
        Bookmark
      </Button>
    </div>
  );
}
