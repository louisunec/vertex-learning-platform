import { Button, Icon, ProgressBar } from "@/components/ui";

export interface CourseProgressBarProps {
  percent: number;
  ctaHref: string | null;
  ctaLabel: string;
}

/** Sticky footer showing the signed-in learner's progress through the course. */
export function CourseProgressBar({ percent, ctaHref, ctaLabel }: CourseProgressBarProps) {
  return (
    <div className="sticky bottom-0 z-10 px-6 pb-6 md:px-12">
      <div className="flex flex-col gap-4 rounded-lg border border-neutral-200 bg-surface px-6 py-5 shadow-lg sm:flex-row sm:items-center sm:gap-8">
        <div className="shrink-0">
          <p className="text-small text-neutral-500">Your Progress</p>
          <p className="mt-1 text-body-lg font-medium text-neutral-900">{percent}% complete</p>
        </div>
        <ProgressBar value={percent} showLabel={false} aria-label="Course progress" className="flex-1" />
        {ctaHref && (
          <Button href={ctaHref} className="h-14 px-6 text-[17px] shadow-sm" iconRight={<Icon name="arrow-right" size={20} />}>
            {ctaLabel}
          </Button>
        )}
      </div>
    </div>
  );
}
