import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { Breadcrumbs } from "@/components/ui";
import { SiteHeader } from "@/components/home/site-header";
import { LoadError } from "@/components/my-learning/card-parts";
import { LearningTabs } from "@/components/my-learning/learning-tabs";
import { ReviewSession } from "@/components/my-learning/reviews/review-session";
import { SignedOut } from "@/components/my-learning/signed-out";
import { FLAGS, isFlagEnabled, isKnowledgeMapEnabled, isReviewEnabled } from "@/lib/flags";

export const metadata: Metadata = {
  title: "Focused review",
  description: "Strengthen what you remember on Vertex, one concept at a time.",
};

/**
 * My Learning → Reviews (prompts/focused-review.md). The page is a shell:
 * the session is started or resumed by the client through
 * `/api/review-session`, which chooses every question on the server.
 * Signed out, it asks for sign-in; with the flag off, it doesn't exist.
 */
export default async function ReviewsPage() {
  const { userId } = await auth();
  const [enabled, knowledgeMap, hints] = userId
    ? await Promise.all([
        isReviewEnabled(userId),
        isKnowledgeMapEnabled(userId),
        isFlagEnabled(FLAGS.helpPolicy, userId),
      ])
    : [true, false, false];
  if (!enabled) notFound();

  return (
    <div className="bg-hatch flex flex-1 flex-col">
      <div className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col border-x border-neutral-200 bg-canvas">
        <SiteHeader activeHref="/my-learning" returnTo="/my-learning/reviews" />
        <LearningTabs active="reviews" knowledgeMap={knowledgeMap} reviews />

        <main className="flex flex-col px-6 pt-10 pb-16 md:px-12" aria-labelledby="focused-review">
          <Breadcrumbs items={[{ label: "My Learning", href: "/my-learning" }, { label: "Reviews" }]} />
          <h1 id="focused-review" className="mt-10 font-display text-display-1 text-neutral-900">
            Focused review
          </h1>
          <p className="mt-3 text-[20px] leading-7 text-neutral-500">Strengthen what you remember, one concept at a time.</p>
          {!userId ? (
            <SignedOut message="Sign in to review the concepts you're working on." returnTo="/my-learning/reviews" />
          ) : process.env.DATABASE_URL?.trim() ? (
            <ReviewSession hints={hints} />
          ) : (
            <NoDatabase />
          )}
        </main>
      </div>
    </div>
  );
}

function NoDatabase() {
  console.error("[reviews] enabled but DATABASE_URL is not set");
  return <LoadError>Learning evidence isn’t available on this server, so a review can’t be started.</LoadError>;
}
