import Link from "next/link";
import { Icon } from "@/components/ui";

export type DueReviewsState = { status: "ready"; due: number } | { status: "error" };

/**
 * The overview's due-review entry (PR-9): a count of the learner's stored
 * review cards that are due now, linking to the Scheduled mode. Nothing when
 * none is due; a failed read says so instead of passing for "none due".
 */
export function DueReviews({ state }: { state: DueReviewsState }) {
  if (state.status === "error") {
    return <p className="text-small text-neutral-500">Your due reviews couldn’t be checked right now.</p>;
  }
  if (state.due === 0) return null;
  return (
    <Link
      href="/my-learning/reviews?mode=scheduled"
      className="inline-flex w-fit items-center gap-2 text-body font-medium text-primary-500 hover:text-primary-600"
    >
      <Icon name="refresh" size={16} />
      {state.due === 1 ? "1 review due now" : `${state.due} reviews due now`}
      <Icon name="arrow-right" size={16} />
    </Link>
  );
}
