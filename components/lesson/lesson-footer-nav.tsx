import { Button, Icon } from "@/components/ui";
import { formatDuration } from "@/lib/format";

export interface FooterLesson {
  href: string;
  title: string;
  durationSeconds: number | null;
}

/**
 * Previous/Next card at the foot of the lesson column. Neighbours come from
 * the course's authored lesson order; a missing side (first/last lesson)
 * renders nothing on that side. Neighbour titles show once the card is wide
 * enough (a container query), so the buttons never squeeze.
 */
export function LessonFooterNav({ prev, next }: { prev: FooterLesson | null; next: FooterLesson | null }) {
  if (!prev && !next) return null;
  return (
    <nav aria-label="Lesson navigation" className="@container rounded-[20px] border border-neutral-200 bg-surface">
      <div className="flex items-center justify-between gap-4 px-4 py-4 @lg:px-5">
        <div className="flex min-w-0 items-center gap-5">
          {prev && (
            <>
              <Button variant="tertiary" size="md" href={prev.href} iconLeft={<Icon name="arrow-left" size={18} />}>
                Previous lesson
              </Button>
              <NeighbourLabel lesson={prev} className="hidden min-w-0 @lg:block" />
            </>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-5">
          {next && (
            <>
              <NeighbourLabel lesson={next} className="hidden min-w-0 text-right @lg:block" />
              <Button size="md" href={next.href} iconRight={<Icon name="arrow-right" size={18} />}>
                Next lesson
              </Button>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}

/** Displays a neighbouring lesson's title and optional duration. */
function NeighbourLabel({ lesson, className }: { lesson: FooterLesson; className?: string }) {
  return (
    <div className={className}>
      <p className="truncate text-body text-neutral-700">{lesson.title}</p>
      {lesson.durationSeconds != null && (
        <p className="mt-0.5 text-small text-neutral-500">{formatDuration(lesson.durationSeconds)}</p>
      )}
    </div>
  );
}
