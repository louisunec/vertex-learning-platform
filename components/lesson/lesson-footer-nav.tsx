import { Button, Icon } from "@/components/ui";
import { formatDuration } from "@/lib/format";

export interface FooterLesson {
  href: string;
  title: string;
  durationSeconds: number | null;
}

/**
 * Sticky Previous/Next bar. Neighbours come from the course's authored lesson
 * order; a missing side (first/last lesson) renders nothing on that side.
 */
export function LessonFooterNav({ prev, next }: { prev: FooterLesson | null; next: FooterLesson | null }) {
  if (!prev && !next) return null;
  return (
    <div className="sticky bottom-0 z-10 border-t border-neutral-200 bg-white">
      <div className="flex items-center justify-between gap-4 px-6 py-4 md:px-12">
        <div className="flex items-center gap-5">
          {prev && (
            <>
              <Button variant="tertiary" href={prev.href} iconLeft={<Icon name="arrow-left" size={18} />}>
                Previous Lesson
              </Button>
              <NeighbourLabel lesson={prev} className="hidden md:block" />
            </>
          )}
        </div>
        <div className="flex items-center gap-5">
          {next && (
            <>
              <NeighbourLabel lesson={next} className="hidden text-right md:block" />
              <Button href={next.href} iconRight={<Icon name="arrow-right" size={18} />}>
                Next Lesson
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Displays a neighbouring lesson's title and optional duration. */
function NeighbourLabel({ lesson, className }: { lesson: FooterLesson; className?: string }) {
  return (
    <div className={className}>
      <p className="text-body font-medium text-neutral-900">{lesson.title}</p>
      {lesson.durationSeconds != null && (
        <p className="mt-0.5 text-small text-neutral-500">{formatDuration(lesson.durationSeconds)}</p>
      )}
    </div>
  );
}
