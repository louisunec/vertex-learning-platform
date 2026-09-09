"use client";

import Image from "next/image";
import Link from "next/link";
import posthog from "posthog-js";
import { Badge, Card, Icon } from "@/components/ui";
import { formatClock } from "@/lib/format";
import type { VideoSearchResult } from "@/lib/search/schema";

/**
 * Grounded video-moment match card. Deep-links to the lesson page at the
 * matched second (`/lessons/<slug>?t=<seconds>`) — playback stays on-site
 * through the provider embed.
 */
export function VideoResultCard({ result }: { result: VideoSearchResult }) {
  const meta: string[] = [];
  if (result.course) {
    meta.push(result.course.title);
    if (result.course.position) meta.push(`Lesson ${result.course.position}`);
  }

  return (
    <Link
      href={result.href}
      className="block focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:outline-none"
      onClick={() =>
        posthog.capture("search_result_clicked", {
          result_type: "video",
          lesson_slug: result.slug,
          course_slug: result.course?.slug ?? null,
          start_seconds: result.startSeconds,
        })
      }
    >
      <Card className="flex gap-4 transition-colors hover:border-primary-400">
        <div className="relative aspect-video w-40 shrink-0 self-start overflow-hidden rounded-md bg-neutral-900 max-sm:hidden">
          {result.posterUrl && (
            <Image
              src={result.posterUrl}
              alt=""
              fill
              sizes="160px"
              className="object-cover opacity-80"
            />
          )}
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="flex size-9 items-center justify-center rounded-full bg-white/90 text-neutral-900">
              <Icon name="play" size={16} aria-hidden />
            </span>
          </span>
          <span className="absolute right-1.5 bottom-1.5 rounded-sm bg-neutral-900/80 px-1.5 py-0.5 font-mono text-[11px] text-white">
            {formatClock(result.startSeconds)}
          </span>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Badge variant="video">video</Badge>
          <h3 className="text-body-lg font-semibold text-neutral-900">{result.title}</h3>
          <p className="text-small leading-5 text-neutral-500">
            <span className="font-medium text-primary-500">{formatClock(result.startSeconds)}</span>
            {" — "}
            {result.momentLabel}
          </p>
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
        </div>
      </Card>
    </Link>
  );
}
