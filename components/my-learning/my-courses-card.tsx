import Link from "next/link";
import { Card, Icon, type IconName } from "@/components/ui";
import { CourseCoverTile } from "@/components/home/course-cover-tile";
import { cn } from "@/lib/cn";
import type { ConceptStatState, MyCoursesState } from "@/lib/my-learning";
import type { MY_LEARNING_COURSES_QUERY_RESULT } from "@/sanity.types";
import { LoadError, SectionHeader } from "./card-parts";

type Course = Pick<MY_LEARNING_COURSES_QUERY_RESULT[number], "title" | "slug" | "summary" | "coverImage">;

export interface MyCoursesCardProps {
  state: MyCoursesState<Course>;
  concepts: ConceptStatState;
}

export function MyCoursesCard({ state, concepts }: MyCoursesCardProps) {
  return (
    <Card className="flex min-w-0 flex-col p-6" role="region" aria-labelledby="my-courses">
      <SectionHeader id="my-courses" title="My courses" href="/courses" linkLabel="View all" />
      {state.status === "ready" ? (
        <div className="mt-6 flex flex-col gap-6 sm:flex-row">
          <CourseCoverTile cover={state.course.coverImage} size={136} alt={state.course.title} />
          <div className="min-w-0 flex-1">
            <h3 className="text-h2 text-neutral-900">
              <Link href={`/courses/${state.course.slug}`} className="hover:text-primary-500">
                {state.course.title}
              </Link>
            </h3>
            {state.course.summary && (
              <p className="mt-2 text-body leading-[21px] text-neutral-500">{state.course.summary}</p>
            )}
            <dl className="mt-4 grid grid-cols-2 border-t border-neutral-200 pt-4">
              <Stat icon="message" label="Lessons completed" value={`${state.completedLessons} / ${state.totalLessons}`} />
              {concepts.status !== "hidden" && (
                <Stat
                  icon="network"
                  label="Concepts with evidence"
                  value={
                    concepts.status === "ready" ? `${concepts.value.withEvidence} / ${concepts.value.total}` : "Couldn’t load"
                  }
                  muted={concepts.status === "error"}
                  className="border-l border-neutral-200 pl-4"
                />
              )}
            </dl>
          </div>
        </div>
      ) : state.status === "error" ? (
        <LoadError>We couldn’t load your courses. Refresh to try again.</LoadError>
      ) : (
        <p className="mt-6 text-body-lg text-neutral-500">
          {state.status === "missing_content"
            ? "The courses you started are no longer available."
            : "You haven’t started a course yet."}{" "}
          <Link href="/courses" className="font-medium text-primary-500 hover:text-primary-600">
            Browse courses
          </Link>
        </p>
      )}
    </Card>
  );
}

function Stat({
  icon,
  label,
  value,
  muted = false,
  className,
}: {
  icon: IconName;
  label: string;
  value: string;
  muted?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 items-center gap-4", className)}>
      <Icon name={icon} size={20} className="text-neutral-700" />
      <div className="min-w-0">
        <dt className="text-small text-neutral-500">{label}</dt>
        <dd className={cn("mt-1", muted ? "text-body text-neutral-500" : "text-h2 font-medium text-neutral-900")}>
          {value}
        </dd>
      </div>
    </div>
  );
}
