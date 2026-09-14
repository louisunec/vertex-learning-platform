import type { ReactNode } from "react";
import Link from "next/link";
import { Card } from "@/components/ui";
import type { RecentLearningKind, RecentLearningState } from "@/lib/my-learning";
import { IconTile, LoadError, SectionHeader } from "./card-parts";

export interface RecentLearningEntry {
  key: string;
  kind: RecentLearningKind;
  label: string;
  lessonTitle: string;
  /** The lesson page; it resumes an unfinished lesson at the saved position. */
  href: string;
  /** ISO timestamp and its display form, e.g. "2 hours ago". */
  at: string;
  when: string;
}

const tiles: Record<RecentLearningKind, ReactNode> = {
  independent_practice: (
    <IconTile tone="neutral" size="sm">
      IP
    </IconTile>
  ),
  hinted_practice: <IconTile icon="check" tone="primary" size="sm" />,
  solution_practice: <IconTile icon="check" tone="primary" size="sm" />,
  repeat_practice: <IconTile icon="refresh" tone="neutral" size="sm" />,
  lesson_completed: <IconTile icon="check-circle" tone="primary" size="sm" />,
  lesson_watched: <IconTile icon="play-solid" tone="primary" size="sm" />,
};

export interface RecentLearningCardProps {
  status: RecentLearningState["status"];
  items: RecentLearningEntry[];
  /** Some activity loaded but another source failed. */
  partial: boolean;
}

export function RecentLearningCard({ status, items, partial }: RecentLearningCardProps) {
  return (
    <Card className="flex min-w-0 flex-col p-6" role="region" aria-labelledby="recent-learning">
      <SectionHeader id="recent-learning" title="Recent learning" />
      {status === "ready" && (
        <>
          <ul className="mt-4">
            {items.map((item) => (
              <li key={item.key} className="group relative flex items-center gap-4 border-b border-neutral-200 py-4">
                {tiles[item.kind]}
                <div className="min-w-0 flex-1">
                  <p className="text-body font-medium text-neutral-900">{item.label}</p>
                  <p className="mt-0.5 truncate text-body text-neutral-500">
                    <Link
                      href={item.href}
                      className="group-hover:text-primary-500 after:absolute after:inset-0 after:rounded-md focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-primary-400"
                    >
                      {item.lessonTitle}
                    </Link>
                  </p>
                </div>
                <time dateTime={item.at} className="shrink-0 text-small text-neutral-500">
                  {item.when}
                </time>
              </li>
            ))}
          </ul>
          {partial && <p className="mt-3 text-small text-neutral-500">Some of your activity couldn’t be loaded.</p>}
        </>
      )}
      {status === "error" && <LoadError>We couldn’t load your recent learning. Refresh to try again.</LoadError>}
      {status === "missing_content" && (
        <p className="mt-6 text-body-lg text-neutral-500">Your recent activity is on lessons that are no longer available.</p>
      )}
      {status === "no_activity" && (
        <p className="mt-6 text-body-lg text-neutral-500">No learning activity yet. Lessons you watch will appear here.</p>
      )}
    </Card>
  );
}
