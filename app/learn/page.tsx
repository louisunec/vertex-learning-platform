import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { Breadcrumbs, Button, Card, Icon } from "@/components/ui";
import { SiteHeader } from "@/components/home/site-header";
import { GoalPicker, type GoalCourseOption } from "@/components/learn/goal-picker";
import { PlanItemCard } from "@/components/learn/plan-item";
import { PlanNotices } from "@/components/learn/plan-parts";
import { Eyebrow, LoadError } from "@/components/my-learning/card-parts";
import { SignedOut } from "@/components/my-learning/signed-out";
import { isNextActionEnabled } from "@/lib/flags";
import { loadGoalCourses, loadPlan, type PlanState } from "@/lib/learner/plan-page";

export const metadata: Metadata = {
  title: "Your learning plan",
  description: "A short, ordered plan from your goal and your answers on Vertex.",
};

/**
 * `/learn` (development plan §5 PR-11): a short, ordered plan for the
 * learner's chosen goal course, built on the server from their own evidence
 * and published content by the same service as `POST /api/next`. Signed
 * out, it asks for sign-in; with the flag off, it doesn't exist. Course
 * browsing stays available throughout.
 */
export default async function LearnPage() {
  const { userId } = await auth();
  if (userId && !(await isNextActionEnabled(userId))) notFound();

  return (
    <div className="bg-hatch flex flex-1 flex-col">
      <div className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col border-x border-neutral-200 bg-canvas">
        <SiteHeader activeHref="/my-learning" returnTo="/learn" />

        <main className="flex flex-col px-6 pt-10 pb-16 md:px-12" aria-labelledby="learning-plan">
          <Breadcrumbs items={[{ label: "My Learning", href: "/my-learning" }, { label: "Learning plan" }]} />
          <h1 id="learning-plan" className="mt-10 font-display text-display-1 text-neutral-900">
            Your learning plan
          </h1>
          <p className="mt-3 text-[20px] leading-7 text-neutral-500">A few next steps, from your goal and your answers so far.</p>
          {userId ? (
            <Plan userId={userId} />
          ) : (
            <SignedOut message="Sign in to see your learning plan." returnTo="/learn" />
          )}
          <p className="mt-10 text-body text-neutral-500">
            Prefer to find your own way?{" "}
            <Link href="/courses" className="font-medium text-primary-500 hover:text-primary-600">
              Browse all courses
            </Link>
          </p>
        </main>
      </div>
    </div>
  );
}

/** Everything below is keyed by the server-resolved Clerk user id. */
async function Plan({ userId }: { userId: string }) {
  const [plan, courses] = await Promise.all([loadPlan(userId), loadGoalCourses()]);
  const options: GoalCourseOption[] | null = courses?.map((course) => ({ id: course._id, title: course.title })) ?? null;

  if (plan.status !== "ready") return <PlanFailure plan={plan} />;
  const { body } = plan;

  if (body.status === "no_goal") {
    return (
      <GoalSection title="Choose a course to focus on" options={options} currentCourseId={null} submitLabel="Set goal">
        Your plan is built from the course you choose and your answers in it. Nothing is chosen for you.
      </GoalSection>
    );
  }
  if (body.status === "goal_unavailable") {
    return (
      <GoalSection title="Your goal course is no longer available" options={options} currentCourseId={null} submitLabel="Set goal">
        It may have been unpublished. Choose another course to build a new plan.
      </GoalSection>
    );
  }

  return (
    <>
      <Card className="mt-10 flex flex-col gap-4 p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <Eyebrow>Current goal</Eyebrow>
            <h2 className="mt-2 text-h2 text-neutral-900">
              <Link href={`/courses/${body.course.slug}`} className="hover:text-primary-500">
                {body.course.title}
              </Link>
            </h2>
            <p className="mt-1 text-body text-neutral-500">
              {body.course.completedLessons} of {body.course.totalLessons} lessons completed
            </p>
          </div>
          {options && (
            <details className="group w-full sm:w-auto sm:min-w-[340px]">
              <summary className="cursor-pointer list-none text-body font-medium text-primary-500 hover:text-primary-600 sm:text-right">
                Change goal
              </summary>
              <div className="mt-3">
                <GoalPicker courses={options} currentCourseId={body.course.id} submitLabel="Save goal" />
              </div>
            </details>
          )}
        </div>
      </Card>

      <PlanNotices notices={body.notices} className="mt-6" />

      {body.items.length > 0 ? (
        <ol className="mt-6 flex flex-col gap-4" aria-label="Plan steps">
          {body.items.map((item, i) => (
            <PlanItemCard key={item.id} item={item} position={i + 1} />
          ))}
        </ol>
      ) : (
        <Card className="mt-6 flex flex-col items-start gap-4 p-6">
          <p className="text-body-lg text-neutral-700">Nothing to recommend in this course right now.</p>
          <Button href={`/courses/${body.course.slug}`} size="md" variant="secondary">
            View the course
          </Button>
        </Card>
      )}
    </>
  );
}

function GoalSection({
  title,
  options,
  currentCourseId,
  submitLabel,
  children,
}: {
  title: string;
  options: GoalCourseOption[] | null;
  currentCourseId: string | null;
  submitLabel: string;
  children: ReactNode;
}) {
  return (
    <Card className="mt-10 flex flex-col gap-4 p-6">
      <div className="flex items-start gap-3">
        <Icon name="target" size={22} className="mt-1 shrink-0 text-primary-500" />
        <div>
          <h2 className="text-h2 text-neutral-900">{title}</h2>
          <p className="mt-1 text-body text-neutral-500">{children}</p>
        </div>
      </div>
      {options ? (
        options.length > 0 ? (
          <GoalPicker courses={options} currentCourseId={currentCourseId} submitLabel={submitLabel} />
        ) : (
          <p className="text-body text-neutral-500">No courses are published yet.</p>
        )
      ) : (
        <LoadError>The course list couldn’t be loaded. Refresh to try again.</LoadError>
      )}
    </Card>
  );
}

function PlanFailure({ plan }: { plan: Exclude<PlanState, { status: "ready" }> }) {
  const message =
    plan.status === "not_configured"
      ? "Learning evidence isn’t available on this server, so a plan can’t be built."
      : plan.source === "content"
        ? "Course content couldn’t be loaded, so your plan can’t be shown. Refresh to try again."
        : "Your learning evidence couldn’t be loaded, so your plan can’t be shown. Refresh to try again.";
  return <LoadError>{message}</LoadError>;
}
