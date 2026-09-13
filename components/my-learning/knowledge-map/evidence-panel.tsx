import Link from "next/link";
import { Badge, Button, Card, Icon } from "@/components/ui";
import { cn } from "@/lib/cn";
import type { MapState } from "@/lib/knowledge-map";
import { LoadError } from "../card-parts";
import { STATE_UI } from "./states";

export type AttemptView = {
  id: string;
  correct: boolean;
  label: string;
  when: string;
  /** The reviewed reason for the option the learner chose, when still servable. */
  reason: string | null;
  badge: string | null;
};

export type SourceView = { lessonLabel: string; lessonTitle: string; href: string };

/** The selected concept: what it is, the learner's own evidence, and where the course teaches it. */
export function EvidencePanel({
  name,
  letter,
  summary,
  state,
  evidenceSummary,
  attempts,
  source,
  courseHref,
}: {
  name: string;
  letter: string;
  summary: string;
  state: MapState;
  evidenceSummary: string | null;
  /** `null` when the attempt read failed. */
  attempts: AttemptView[] | null;
  source: SourceView | null;
  courseHref: string;
}) {
  const ui = STATE_UI[state];

  return (
    <Card className="flex flex-col p-6" aria-labelledby="concept-name">
      <div className="flex items-start gap-4">
        <span
          aria-hidden="true"
          className={cn("flex size-10 shrink-0 items-center justify-center rounded-sm text-body font-semibold", ui.tile)}
        >
          {letter}
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="concept-name" className="text-h1 font-medium break-words text-neutral-900">
            {name}
          </h2>
          {/* On phones the state sits under the name so the name keeps its width. */}
          <div className="mt-2 sm:hidden">
            <Badge variant={ui.badge}>{ui.label}</Badge>
          </div>
        </div>
        <div className="mt-1 hidden shrink-0 sm:block">
          <Badge variant={ui.badge}>{ui.label}</Badge>
        </div>
      </div>
      {summary && <p className="mt-6 text-body-lg text-neutral-700">{summary}</p>}

      <section aria-labelledby="learning-evidence" className="mt-6 border-t border-neutral-200 pt-6">
        <h3 id="learning-evidence" className="text-h3 text-neutral-900">
          Learning evidence
        </h3>
        {attempts === null ? (
          <LoadError>Your attempts on this concept couldn’t be loaded. Refresh to try again.</LoadError>
        ) : attempts.length === 0 ? (
          <p className="mt-3 text-small text-neutral-500">No attempts on this concept yet.</p>
        ) : (
          <>
            {evidenceSummary && <p className="mt-3 text-small text-neutral-500">{evidenceSummary}</p>}
            <ul className="mt-4 flex flex-col gap-3">
              {attempts.map((attempt) => (
                <li key={attempt.id} className="flex gap-3 rounded-md border border-neutral-200 bg-neutral-50 p-4">
                  <span
                    className={cn(
                      "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full",
                      attempt.correct ? "bg-success text-on-primary" : "bg-danger text-white",
                    )}
                  >
                    <Icon name={attempt.correct ? "check" : "x"} size={12} strokeWidth={2.5} />
                    <span className="sr-only">{attempt.correct ? "Correct" : "Incorrect"}</span>
                  </span>
                  <div className="min-w-0">
                    <p className="text-body">
                      <span className="font-medium text-neutral-900">{attempt.label}</span>
                      <span className="text-neutral-500"> · {attempt.when}</span>
                    </p>
                    {attempt.reason && <p className="mt-1 text-body text-neutral-700">{attempt.reason}</p>}
                    {attempt.badge && (
                      <Badge variant={attempt.badge === "Assisted" ? "developing" : "neutral"} className="mt-3">
                        {attempt.badge}
                      </Badge>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {source && (
        <section aria-labelledby="related-source" className="mt-6 border-t border-neutral-200 pt-6">
          <div className="flex items-center justify-between gap-4">
            <h3 id="related-source" className="text-h3 text-neutral-900">
              Related source
            </h3>
            <Link
              href={courseHref}
              className="inline-flex items-center gap-1 text-body font-medium text-primary-500 hover:text-primary-600"
            >
              View in course
              <Icon name="arrow-right" size={14} />
            </Link>
          </div>
          <Link
            href={source.href}
            className="mt-4 flex items-center gap-3 rounded-md border border-neutral-200 bg-neutral-50 p-4 transition-colors hover:border-neutral-300"
          >
            <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-sm bg-primary-100 text-primary-500">
              <Icon name="play-solid" size={14} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-small text-neutral-500">{source.lessonLabel}</span>
              <span className="block truncate text-body font-medium text-neutral-900">{source.lessonTitle}</span>
            </span>
            <Icon name="chevron-right" size={16} className="shrink-0 text-neutral-500" />
          </Link>
        </section>
      )}

      <div className="mt-6 flex flex-col gap-3">
        <Button disabled className="w-full" iconRight={<Icon name="arrow-right" size={16} />} aria-describedby="practice-soon">
          Practise this concept
        </Button>
        <p id="practice-soon" className="-mt-1 text-center text-small text-neutral-500">
          Practice sessions are coming soon.
        </p>
        {source && (
          <Button href={source.href} variant="tertiary" className="w-full" iconLeft={<Icon name="play-solid" size={12} />}>
            Watch explanation
          </Button>
        )}
      </div>
    </Card>
  );
}
