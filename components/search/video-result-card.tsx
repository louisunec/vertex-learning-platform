"use client";

import Image from "next/image";
import Link from "next/link";
import { Badge, Card, Icon } from "@/components/ui";
import { formatClock } from "@/lib/format";
import { SearchCourseIcon } from "./search-course-icon";
import type { VideoSearchResult } from "@/lib/search/schema";

/**
 * Grounded video-moment match row. Deep-links to the lesson page at the
 * matched second (`/lessons/<slug>?t=<seconds>`) — playback stays on-site
 * through the provider embed. The thumbnail badge and the action label both
 * show that matched second, never the lesson's total duration.
 */
export function VideoResultCard({ result, onOpen }: { result: VideoSearchResult; onOpen?: () => void }) {
  const startClock = formatClock(result.startSeconds);

  return (
    <Link
      href={result.href}
      className="block rounded-lg focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:outline-none"
      onClick={onOpen}
    >
      <Card className="flex flex-col gap-4 p-4 transition-colors hover:border-primary-400 md:flex-row md:gap-8">
        <div className="relative aspect-video shrink-0 overflow-hidden rounded-md bg-black md:w-[275px]">
          {result.posterUrl && (
            <Image
              src={result.posterUrl}
              alt=""
              fill
              sizes="(min-width: 768px) 275px, 100vw"
              className="object-cover"
            />
          )}
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-white/90 text-black">
              <Icon name="play" size={22} aria-hidden />
            </span>
          </span>
          <span className="absolute right-2.5 bottom-2.5 rounded-sm bg-black/85 px-2 py-1 text-body font-medium text-white">
            {startClock}
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
            <Badge variant="video" className="ml-auto">
              video
            </Badge>
          </div>

          <h3 className="mt-3 text-[19px] leading-7 font-semibold text-neutral-900">{result.title}</h3>
          <p className="mt-1.5 text-body-lg leading-6 text-neutral-500">{result.momentLabel}</p>

          <div className="mt-auto flex flex-wrap items-center justify-between gap-x-6 gap-y-2 pt-4">
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body-lg text-neutral-700">
              {result.course?.position && (
                <span className="inline-flex items-center gap-2">
                  <Icon name="file" size={16} className="text-neutral-700" aria-hidden />
                  Lesson {result.course.position}
                </span>
              )}
              {result.course?.position && result.course?.moduleTitle && (
                <span aria-hidden="true" className="text-neutral-300">
                  ·
                </span>
              )}
              {result.course?.moduleTitle && (
                <span className="inline-flex items-center gap-2">
                  <Icon name="folder" size={16} className="text-neutral-700" aria-hidden />
                  {result.course.moduleTitle}
                </span>
              )}
            </span>

            <span className="ml-auto inline-flex items-center gap-2 text-body-lg font-medium text-primary-500">
              <Icon name="play" filled size={18} aria-hidden />
              Watch from {startClock}
              <Icon name="chevron-right" size={16} aria-hidden />
            </span>
          </div>
        </div>
      </Card>
    </Link>
  );
}
