import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";
import { SiteHeader } from "@/components/home/site-header";
import { ComingSoon } from "@/components/my-learning/coming-soon";
import { DueReviews, type DueReviewsState } from "@/components/my-learning/due-reviews";
import { GoalCard, type GoalCardState } from "@/components/my-learning/goal-card";
import { LearningTabs } from "@/components/my-learning/learning-tabs";
import { MyCoursesCard } from "@/components/my-learning/my-courses-card";
import { NextStepCard } from "@/components/my-learning/next-step-card";
import { RecentLearningCard } from "@/components/my-learning/recent-learning-card";
import { RecommendedCard } from "@/components/my-learning/recommended-card";
import { SignedOut } from "@/components/my-learning/signed-out";
import { getDb } from "@/lib/db/client";
import { asLearner } from "@/lib/db/learner-scope";
import {
  FLAGS,
  isFlagEnabled,
  isKnowledgeMapEnabled,
  isNextActionEnabled,
  isReviewEnabled,
  isScheduledReviewEnabled,
} from "@/lib/flags";
import { formatRelativeTime } from "@/lib/format";
import { sanityLearnerContent } from "@/lib/learner/content";
import { readLearnerOverview } from "@/lib/learner/overview";
import { loadGoalCourses, loadPlan, type PlanState } from "@/lib/learner/plan-page";
import { readDueSummary } from "@/lib/review/cards";
import {
  buildOverviewState,
  conceptStatState,
  countConceptsWithEvidence,
  recentLessonIds,
  type ConceptEvidence,
  type EvidenceState,
  type Loaded,
} from "@/lib/my-learning";
import {
  getConceptIdsForLessons,
  getCoursesContainingLessons,
  getLessonsByIds,
  getProgressForUser,
} from "@/sanity/data";

export const metadata: Metadata = {
  title: "My Learning",
  description: "Your courses, progress, and recent practice on Vertex.",
};

export default async function MyLearningPage() {
  const { userId } = await auth();
  const [knowledgeMap, reviews, scheduled, nextAction] = userId
    ? await Promise.all([
        isKnowledgeMapEnabled(userId),
        isReviewEnabled(userId),
        isScheduledReviewEnabled(userId),
        isNextActionEnabled(userId),
      ])
    : [false, false, false, false];

  return (
    <div className="bg-hatch flex flex-1 flex-col">
      <div className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col border-x border-neutral-200 bg-canvas">
        <SiteHeader activeHref="/my-learning" returnTo="/my-learning" />
        <LearningTabs active="overview" knowledgeMap={knowledgeMap} reviews={reviews} />

        <main className="flex flex-col px-6 pt-10 pb-16 md:px-12" aria-labelledby="my-learning">
          <h1 id="my-learning" className="font-display text-display-1 text-neutral-900">
            My Learning
          </h1>
          <p className="mt-3 text-[20px] leading-7 text-neutral-500">A clear next step, every time.</p>
          {userId ? (
            <Overview userId={userId} reviews={reviews} scheduled={scheduled} knowledgeMap={knowledgeMap} nextAction={nextAction} />
          ) : (
            <SignedOut
              message="Sign in to see your courses, progress, and recent learning."
              returnTo="/my-learning"
            />
          )}
        </main>
      </div>
    </div>
  );
}

/** Everything below is keyed by the server-resolved Clerk user id. */
async function Overview({
  userId,
  reviews,
  scheduled,
  knowledgeMap,
  nextAction,
}: {
  userId: string;
  reviews: boolean;
  scheduled: boolean;
  knowledgeMap: boolean;
  nextAction: boolean;
}) {
  const [progress, evidence, due, plan, goalCourses] = await Promise.all([
    settle("progress", getProgressForUser(userId)),
    readEvidence(userId),
    scheduled ? readDueReviews(userId) : null,
    nextAction ? loadPlan(userId) : null,
    nextAction ? loadGoalCourses() : null,
  ]);
  const rows = progress.ok ? progress.value : [];
  const attempts = evidence.status === "ready" ? evidence.recentAttempts : [];
  const progressLessonIds = [...new Set(rows.map((row) => row.lessonId))];
  const feedLessonIds = recentLessonIds(rows, attempts);

  const [courses, feedLessons] = await Promise.all([
    progressLessonIds.length > 0 ? settle("courses", getCoursesContainingLessons(progressLessonIds)) : loaded([]),
    feedLessonIds.length > 0 ? settle("lesson titles", getLessonsByIds(feedLessonIds)) : loaded([]),
  ]);

  const state = buildOverviewState({ progress, courses, feedLessons, evidence });
  const concepts = conceptStatState(
    evidence,
    state.active && evidence.status === "ready"
      ? await readConceptEvidence(state.active.course, evidence.independentConceptIds)
      : null,
  );

  const now = new Date();
  const recentItems =
    state.recent.status === "ready"
      ? state.recent.items.map((item) => ({
          key: item.key,
          kind: item.kind,
          label: item.label,
          lessonTitle: item.lesson.title,
          at: item.at,
          when: formatRelativeTime(item.at, now),
        }))
      : [];

  // Next actions (PR-11), when on: the goal beside one recommendation. Otherwise, or
  // when the plan has nothing or can't be read, the existing next step stays.
  const primary = plan?.status === "ready" && plan.body.status === "ready" ? (plan.body.items[0] ?? null) : null;
  const step = state.nextStep;
  const continueLesson =
    primary && step.kind === "continue" && (primary.kind !== "continue" || primary.lesson?.id !== step.lesson._id)
      ? { title: step.lesson.title, href: `/lessons/${step.lesson.slug}` }
      : null;
  const mappedSlugs = new Set(courses.ok ? courses.value.map((course) => course.slug) : []);

  return (
    <div className="mt-10 flex flex-col gap-6">
      {plan ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <GoalCard
            state={goalCardState(plan, knowledgeMap ? mappedSlugs : new Set())}
            courses={goalCourses?.map((course) => ({ id: course._id, title: course.title })) ?? null}
          />
          {primary ? (
            <RecommendedCard item={primary} continueLesson={continueLesson} />
          ) : (
            <NextStepCard step={step} />
          )}
        </div>
      ) : (
        <NextStepCard step={step} />
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <MyCoursesCard state={state.myCourses} concepts={concepts} />
        <RecentLearningCard
          status={state.recent.status}
          items={recentItems}
          partial={state.recent.status === "ready" && state.recent.partial}
        />
      </div>
      {due && <DueReviews state={due} />}
      <ComingSoon reviews={reviews} nextAction={nextAction} />
    </div>
  );
}

/** How many of the learner's review cards are due now (PR-9); a failure is reported, never read as zero. */
async function readDueReviews(userId: string): Promise<DueReviewsState> {
  if (!process.env.DATABASE_URL?.trim()) return { status: "error" };
  try {
    const summary = await asLearner(getDb(), userId, (tx) => readDueSummary(tx, userId, new Date()));
    return { status: "ready", due: summary.due };
  } catch (error) {
    console.error("[my-learning] due reviews read failed:", error instanceof Error ? error.message : error);
    return { status: "error" };
  }
}

/** The goal card for a plan read; a failed read is an error, never "no goal". */
function goalCardState(plan: PlanState, mappedSlugs: ReadonlySet<string>): GoalCardState {
  if (plan.status !== "ready") return { status: "error" };
  const { body } = plan;
  if (body.status !== "ready") return { status: body.status };
  const { slug } = body.course;
  return {
    status: "ready",
    course: body.course,
    mapHref: mappedSlugs.has(slug) ? `/my-learning/knowledge-map?course=${encodeURIComponent(slug)}` : null,
  };
}

function loaded<T>(value: T): Loaded<T> {
  return { ok: true, value };
}

/** Settles a read; a failure is logged and reported as such, never as an empty result. */
async function settle<T>(label: string, read: Promise<T>): Promise<Loaded<T>> {
  try {
    return loaded(await read);
  } catch (error) {
    console.error(`[my-learning] ${label} read failed:`, error instanceof Error ? error.message : error);
    return { ok: false };
  }
}

/**
 * Learner evidence (PR-4) behind its flag. With the flag on, a missing
 * database is a configuration failure and a failed read is an error; both
 * are shown, not hidden.
 */
async function readEvidence(userId: string): Promise<EvidenceState> {
  if (!(await isFlagEnabled(FLAGS.learnerEvidence, userId))) return { status: "flag_disabled" };
  if (!process.env.DATABASE_URL?.trim()) {
    console.error("[my-learning] learner-evidence is on but DATABASE_URL is not set");
    return { status: "not_configured" };
  }
  try {
    return { status: "ready", ...(await readLearnerOverview(getDb(), userId)) };
  } catch (error) {
    console.error("[my-learning] learner evidence read failed:", error instanceof Error ? error.message : error);
    return { status: "error" };
  }
}

async function readConceptEvidence(
  course: { modules: Array<{ lessons: Array<{ _id: string }> | null }> | null },
  independentConceptIds: string[],
): Promise<Loaded<ConceptEvidence | null>> {
  const lessonIds = (course.modules ?? []).flatMap((module) => (module.lessons ?? []).map((lesson) => lesson._id));
  if (lessonIds.length === 0) return loaded(null);
  return settle(
    "concepts",
    Promise.all([getConceptIdsForLessons(lessonIds), sanityLearnerContent.loadConceptIndex()]).then(([ids, index]) =>
      countConceptsWithEvidence(ids, independentConceptIds, index),
    ),
  );
}
