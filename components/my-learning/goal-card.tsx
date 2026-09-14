import Link from "next/link";
import { Card, Icon, ProgressBar } from "@/components/ui";
import { GoalPicker, type GoalCourseOption } from "@/components/learn/goal-picker";
import { IconTile, LoadError } from "./card-parts";

export type GoalCardState =
  | {
      status: "ready";
      course: { id: string; title: string; slug: string; completedLessons: number; totalLessons: number };
      /** The knowledge map for this course, when the map is on and lists it. */
      mapHref: string | null;
    }
  | { status: "no_goal" }
  | { status: "goal_unavailable" }
  | { status: "error" };

/**
 * The learner's current goal (development plan §5 PR-11): a course they
 * chose, with lesson progress from their own stored rows. Without a goal it
 * asks the learner to choose one; nothing is inferred.
 */
export function GoalCard({ state, courses }: { state: GoalCardState; courses: GoalCourseOption[] | null }) {
  const picker = (currentCourseId: string | null, submitLabel: string) =>
    courses ? (
      <GoalPicker courses={courses} currentCourseId={currentCourseId} submitLabel={submitLabel} />
    ) : (
      <LoadError>The course list couldn’t be loaded. Refresh to try again.</LoadError>
    );

  return (
    <Card className="flex min-w-0 flex-col p-6 md:p-8" role="region" aria-labelledby="current-goal">
      <div className="flex items-center justify-between gap-4">
        <h2 id="current-goal" className="text-small font-medium tracking-[0.14em] text-neutral-500 uppercase">
          Current goal
        </h2>
      </div>

      {state.status === "ready" ? (
        <>
          <div className="mt-5 flex items-start gap-5">
            <IconTile icon="target" tone="primary" size="lg" />
            <div className="min-w-0">
              <h3 className="text-[24px] leading-8 font-semibold text-neutral-900">
                <Link href={`/courses/${state.course.slug}`} className="hover:text-primary-500">
                  {state.course.title}
                </Link>
              </h3>
              <p className="mt-1 text-[15px] leading-[21px] text-neutral-500">
                {state.course.completedLessons} of {state.course.totalLessons} lessons completed
              </p>
            </div>
          </div>
          {state.course.totalLessons > 0 && (
            <ProgressBar
              className="mt-5"
              value={(state.course.completedLessons / state.course.totalLessons) * 100}
              showLabel={false}
              aria-label="Lessons completed in your goal course"
            />
          )}
          <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3">
            {state.mapHref && (
              <Link
                href={state.mapHref}
                className="inline-flex items-center gap-1.5 text-body font-medium text-primary-500 hover:text-primary-600"
              >
                View knowledge map
                <Icon name="arrow-right" size={14} />
              </Link>
            )}
            {courses && (
              <details className="w-full">
                <summary className="w-fit cursor-pointer list-none text-body font-medium text-primary-500 hover:text-primary-600">
                  Change goal
                </summary>
                <div className="mt-3">{picker(state.course.id, "Save goal")}</div>
              </details>
            )}
          </div>
        </>
      ) : state.status === "error" ? (
        <LoadError>Your goal couldn’t be loaded. Refresh to try again.</LoadError>
      ) : (
        <div className="mt-5 flex flex-col gap-4">
          <div>
            <h3 className="text-[24px] leading-8 font-semibold text-neutral-900">
              {state.status === "no_goal" ? "No goal yet" : "Your goal course is no longer available"}
            </h3>
            <p className="mt-1 text-[15px] leading-[21px] text-neutral-500">
              {state.status === "no_goal"
                ? "Choose a course to focus on, and your recommendations will come from your answers in it."
                : "It may have been unpublished. Choose another course to focus on."}
            </p>
          </div>
          {picker(null, "Set goal")}
        </div>
      )}
    </Card>
  );
}
