import Link from "next/link";
import { Card, Icon } from "@/components/ui";
import { cn } from "@/lib/cn";
import { REASON_TEXT, sessionSummary, type ActiveReview, type AnyReviewReason, type ConceptProgress } from "@/lib/focused-review";

/**
 * The review's side column: where the learner is in the session and why
 * this concept was chosen. "Save and leave" only navigates: every answer is
 * already stored, and the session resumes from the server on return.
 */
export function SessionSidebar({
  summary,
  progress,
  reason,
}: {
  summary: ActiveReview;
  progress: ConceptProgress[];
  reason: AnyReviewReason | null;
}) {
  const scheduled = summary.mode === "scheduled";
  const unavailable = summary.unavailableDue ?? 0;
  return (
    <aside className="flex flex-col gap-6" aria-label="Review session">
      <Card className="rounded-[20px] p-6">
        <h2 className="text-h2 text-neutral-900">Your session</h2>
        <p className="mt-4 flex items-center gap-2 text-body text-neutral-500">
          <Icon name="target" size={16} />
          {sessionSummary(summary)}
        </p>
        <ol className="mt-5 flex flex-col gap-5">
          {progress.map((concept) => (
            <li key={concept.conceptId} className="flex items-start gap-4">
              <span
                aria-hidden="true"
                className={cn(
                  "mt-0.5 grid size-6 shrink-0 place-items-center rounded-full",
                  concept.status === "current" && "bg-primary-500",
                  concept.status === "done" && "bg-primary-100 text-primary-500",
                  concept.status === "next" && "border-2 border-neutral-300",
                )}
              >
                {concept.status === "done" && <Icon name="check" size={14} />}
              </span>
              <div>
                <p className="text-body-lg text-neutral-900">{concept.name ?? "Concept no longer available"}</p>
                <p className={cn("text-body", concept.status === "current" ? "text-primary-500" : "text-neutral-500")}>
                  {concept.label}
                </p>
              </div>
            </li>
          ))}
        </ol>
        {unavailable > 0 && (
          <p className="mt-5 text-small text-neutral-500">
            {unavailable === 1
              ? "1 due review has no available question right now, so it isn’t in this session. Its schedule is unchanged."
              : `${unavailable} due reviews have no available question right now, so they aren’t in this session. Their schedules are unchanged.`}
          </p>
        )}
      </Card>

      <Card className="rounded-[20px] p-6">
        <h2 className="text-h2 text-neutral-900">Why this review?</h2>
        <ul className="mt-5 flex flex-col gap-5">
          {reason && (
            <li className="flex items-start gap-4">
              <span aria-hidden="true" className="grid size-11 shrink-0 place-items-center rounded-md bg-neutral-50 text-neutral-700">
                <Icon name="file" size={18} />
              </span>
              <p className="text-body text-neutral-700">{REASON_TEXT[reason]}</p>
            </li>
          )}
          <li className="flex items-start gap-4">
            <span aria-hidden="true" className="grid size-11 shrink-0 place-items-center rounded-md bg-neutral-50 text-neutral-700">
              <Icon name="chart" size={18} />
            </span>
            <p className="text-body text-neutral-700">
              {scheduled
                ? "Your answer sets when this comes back: a miss brings it back sooner. A correct answer after a hint or the refresher leaves your schedule as it is."
                : "Answering without help updates your mastery estimate; with a hint, it’s recorded as assisted practice."}
            </p>
          </li>
        </ul>
        <div className="mt-5 border-t border-neutral-200 pt-4">
          <Link
            href="/my-learning"
            className="inline-flex items-center gap-2 text-body font-medium text-primary-500 hover:text-primary-600"
          >
            <Icon name="bookmark" size={16} />
            Save and leave
          </Link>
        </div>
      </Card>
    </aside>
  );
}
