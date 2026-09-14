import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { Breadcrumbs } from "@/components/ui";
import { SiteHeader } from "@/components/home/site-header";
import { LoadError } from "@/components/my-learning/card-parts";
import { LearningTabs } from "@/components/my-learning/learning-tabs";
import { ReviewSession } from "@/components/my-learning/reviews/review-session";
import { SignedOut } from "@/components/my-learning/signed-out";
import { cn } from "@/lib/cn";
import { FLAGS, isFlagEnabled, isKnowledgeMapEnabled, isReviewEnabled, isScheduledReviewEnabled } from "@/lib/flags";
import type { ReviewMode } from "@/lib/learner/contracts";

export const metadata: Metadata = {
  title: "Focused review",
  description: "Strengthen what you remember on Vertex, one concept at a time.",
};

type Props = {
  searchParams: Promise<{ mode?: string | string[] }>;
};

const HEADINGS: Record<ReviewMode, { title: string; lead: string }> = {
  mistakes: { title: "Focused review", lead: "Strengthen what you remember, one concept at a time." },
  scheduled: { title: "Scheduled review", lead: "Check what your review schedule says is due, before you forget it." },
};

/**
 * My Learning → Reviews (prompts/focused-review.md,
 * prompts/pr-9-scheduled-review.md). The page is a shell: the session is
 * started or resumed by the client through `/api/review-session`, which
 * chooses every question on the server. Mistakes is the default mode;
 * Scheduled (`?mode=scheduled`) exists only while `scheduled-review` is on.
 * Signed out, it asks for sign-in; with the flag off, it doesn't exist.
 */
export default async function ReviewsPage({ searchParams }: Props) {
  const [{ userId }, sp] = await Promise.all([auth(), searchParams]);
  const [enabled, knowledgeMap, hints, scheduledEnabled] = userId
    ? await Promise.all([
        isReviewEnabled(userId),
        isKnowledgeMapEnabled(userId),
        isFlagEnabled(FLAGS.helpPolicy, userId),
        isScheduledReviewEnabled(userId),
      ])
    : [true, false, false, false];
  if (!enabled) notFound();
  const requested = sp.mode === "scheduled" ? "scheduled" : "mistakes";
  if (requested === "scheduled" && userId && !scheduledEnabled) notFound();
  const mode: ReviewMode = userId ? requested : "mistakes";
  const heading = HEADINGS[mode];

  return (
    <div className="bg-hatch flex flex-1 flex-col">
      <div className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col border-x border-neutral-200 bg-canvas">
        <SiteHeader activeHref="/my-learning" returnTo="/my-learning/reviews" />
        <LearningTabs active="reviews" knowledgeMap={knowledgeMap} reviews />

        <main className="flex flex-col px-6 pt-10 pb-16 md:px-12" aria-labelledby="focused-review">
          <Breadcrumbs items={[{ label: "My Learning", href: "/my-learning" }, { label: "Reviews" }]} />
          <h1 id="focused-review" className="mt-10 font-display text-display-1 text-neutral-900">
            {heading.title}
          </h1>
          <p className="mt-3 text-[20px] leading-7 text-neutral-500">{heading.lead}</p>
          {scheduledEnabled && <ModeSwitch mode={mode} />}
          {!userId ? (
            <SignedOut message="Sign in to review the concepts you're working on." returnTo="/my-learning/reviews" />
          ) : process.env.DATABASE_URL?.trim() ? (
            <ReviewSession key={mode} hints={hints} mode={mode} />
          ) : (
            <NoDatabase />
          )}
        </main>
      </div>
    </div>
  );
}

/** Mistakes and Scheduled are two separate sessions; switching never ends either one. */
function ModeSwitch({ mode }: { mode: ReviewMode }) {
  const modes = [
    { key: "mistakes", label: "Mistakes", href: "/my-learning/reviews" },
    { key: "scheduled", label: "Scheduled", href: "/my-learning/reviews?mode=scheduled" },
  ] as const;
  return (
    <nav aria-label="Review mode" className="mt-6">
      <ul className="flex flex-wrap gap-3">
        {modes.map((item) => (
          <li key={item.key}>
            <Link
              href={item.href}
              aria-current={item.key === mode ? "page" : undefined}
              className={cn(
                "inline-flex h-11 items-center rounded-full border px-6 text-body transition-colors",
                item.key === mode
                  ? "border-primary-400 bg-primary-100 text-primary-500"
                  : "border-neutral-200 text-neutral-900 hover:border-neutral-300",
              )}
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function NoDatabase() {
  console.error("[reviews] enabled but DATABASE_URL is not set");
  return <LoadError>Learning evidence isn’t available on this server, so a review can’t be started.</LoadError>;
}
