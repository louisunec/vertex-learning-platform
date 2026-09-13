"use client";

import { useId, useState, type RefObject } from "react";
import { Button, Card, Icon, ProgressBar } from "@/components/ui";
import { cn } from "@/lib/cn";
import { REASON_CHIPS } from "@/lib/focused-review";
import { formatClock } from "@/lib/format";
import { helpActions, type HelpActionRequest } from "@/lib/lesson/help-actions";
import type { AttemptResult, HelpResponse, ReviewItem, ReviewReason } from "@/lib/learner/contracts";

export type Question = {
  item: Extract<ReviewItem, { state: "open" }>;
  level: 0 | 1 | 2 | 3;
  hints: HelpResponse["hint"][];
  selected: string | null;
  confidence: number | null;
  /** Set on the first submit and reused by retries, so a retry can never record twice. */
  idempotencyKey: string | null;
  outcome: { kind: "graded"; result: AttemptResult } | { kind: "closed"; message: string } | null;
  /** Reused by retries, so opening the refresher is recorded once. */
  refresherKey: string | null;
};

/** The stored 1–5 self-confidence scale (`pre_feedback_1to5_v1`), asked before the result. */
const CONFIDENCE = [
  [1, "Guessing"],
  [2, "Unsure"],
  [3, "Fairly sure"],
  [4, "Sure"],
  [5, "Certain"],
] as const;

const EVIDENCE_TEXT: Record<AttemptResult["evidence"]["kind"], string> = {
  independent: "You answered this on your own, so it counts as independent evidence.",
  assisted: "You used help on this question, so it counts as practice with help.",
  not_counted: "You've answered this question before, so it doesn't add new evidence.",
};

const LETTERS = ["A", "B", "C", "D"];

/** The review's first hint is "Give me a hint"; later rungs keep the lesson check's labels. */
function helpLabel(request: HelpActionRequest, label: string): string {
  return request === "hint" ? "Give me a hint" : label;
}

export function QuestionCard({
  question,
  total,
  concept,
  hints,
  busy,
  failure,
  headingRef,
  last,
  onSelect,
  onConfidence,
  onHelp,
  onSubmit,
  onRefresher,
  onNext,
}: {
  question: Question;
  total: number;
  concept: { name: string | null; reason: ReviewReason } | null;
  hints: boolean;
  busy: boolean;
  failure: { message: string; retry: (() => void) | null } | null;
  headingRef: RefObject<HTMLHeadingElement | null>;
  last: boolean;
  onSelect: (optionId: string) => void;
  onConfidence: (confidence: number | null) => void;
  onHelp: (request: HelpActionRequest) => void;
  onSubmit: () => void;
  onRefresher: () => void;
  onNext: () => void;
}) {
  const id = useId();
  const { item, outcome } = question;
  const result = outcome?.kind === "graded" ? outcome.result : null;
  // A submit is in flight or awaiting retry: the answer is locked so a retry resends the same body.
  const locked = busy || question.idempotencyKey !== null || outcome !== null;
  const solution = question.hints.find((hint) => hint.level === 3);
  const correctOptionId = solution?.level === 3 ? solution.correctOptionId : result?.correct ? question.selected : null;
  const offered = hints && outcome?.kind !== "closed" ? helpActions({ level: question.level, answered: result !== null, correct: result?.correct }) : [];

  return (
    <Card className="ph-no-capture rounded-[20px] p-6">
      <div className="flex flex-col gap-3 border-b border-neutral-200 pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <p className="shrink-0 text-body text-neutral-900">
            Question {item.position} of {total}
          </p>
          <ProgressBar
            value={(item.position / total) * 100}
            showLabel={false}
            className="w-[180px] sm:w-[245px]"
          />
        </div>
        {concept && (
          <p className="flex items-center gap-2 text-small text-neutral-500">
            <Icon name="refresh" size={14} />
            {[concept.name, REASON_CHIPS[concept.reason]].filter(Boolean).join(" · ")}
          </p>
        )}
      </div>

      <fieldset disabled={locked} className="mt-6 flex flex-col gap-3">
        <legend className="mb-6">
          <h2
            ref={outcome ? undefined : headingRef}
            tabIndex={-1}
            className="text-h2 text-neutral-900 focus:outline-none"
          >
            {item.task.item.question}
          </h2>
        </legend>
        {item.task.item.options.map((option, i) => {
          const chosen = question.selected === option.id;
          return (
            <label
              key={option.id}
              className={cn(
                "flex min-h-14 cursor-pointer items-center gap-4 rounded-md border px-4 py-2.5 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary-400",
                chosen ? "border-primary-400 bg-primary-100" : "border-neutral-200 hover:border-neutral-300",
                locked && "cursor-default",
              )}
            >
              <input
                type="radio"
                name={`${id}-${item.task.taskInstanceId}`}
                value={option.id}
                checked={chosen}
                onChange={() => onSelect(option.id)}
                className="sr-only"
              />
              <span
                aria-hidden="true"
                className={cn(
                  "grid size-[34px] shrink-0 place-items-center rounded-full border text-body font-medium",
                  chosen ? "border-transparent bg-primary-500 text-on-primary" : "border-neutral-200 text-neutral-900",
                )}
              >
                {LETTERS[i]}
              </span>
              <span className="flex-1 font-mono text-body-lg break-words text-neutral-900">{option.text}</span>
              {correctOptionId === option.id && (
                <span className="inline-flex shrink-0 items-center gap-1 text-small text-success">
                  <Icon name="check" size={14} /> Correct answer
                </span>
              )}
            </label>
          );
        })}
      </fieldset>

      {question.hints.length > 0 && (
        <div className="mt-6 flex flex-col gap-2">
          {question.hints.map((hint) => (
            <div key={hint.level} className="rounded-md border border-neutral-200 px-4 py-3">
              <p className="text-small tracking-wider text-neutral-500 uppercase">{hint.level === 3 ? "Explanation" : `Hint ${hint.level}`}</p>
              <p className="mt-1 text-body-lg text-neutral-900">{hint.text}</p>
            </div>
          ))}
        </div>
      )}

      {!outcome ? (
        <>
          <fieldset disabled={locked} className="mt-7">
            <legend className="text-body text-neutral-900">How sure are you?</legend>
            <div className="mt-3 flex flex-wrap gap-3">
              {CONFIDENCE.map(([value, label]) => (
                <label
                  key={value}
                  className={cn(
                    "inline-flex h-11 cursor-pointer items-center rounded-full border px-6 text-body transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary-400",
                    question.confidence === value
                      ? "border-primary-400 bg-primary-100 text-primary-500"
                      : "border-neutral-200 text-neutral-900 hover:border-neutral-300",
                  )}
                >
                  <input
                    type="radio"
                    name={`${id}-${item.task.taskInstanceId}-confidence`}
                    value={value}
                    checked={question.confidence === value}
                    onChange={() => onConfidence(value)}
                    className="sr-only"
                  />
                  {label}
                </label>
              ))}
              {question.confidence !== null && (
                <button type="button" onClick={() => onConfidence(null)} className="px-2 text-small text-neutral-500 hover:text-neutral-900">
                  Clear
                </button>
              )}
            </div>
          </fieldset>

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <Button
              onClick={onSubmit}
              disabled={!question.selected || locked}
              iconRight={<Icon name="arrow-right" size={18} />}
              className="w-full"
            >
              Check answer
            </Button>
            {offered.length > 0 && (
              <div className="flex gap-3">
                {offered.map((action) => (
                  <Button
                    key={action.request}
                    variant="tertiary"
                    disabled={busy}
                    onClick={() => onHelp(action.request)}
                    iconLeft={action.request === "hint" ? <Icon name="bulb" size={18} /> : undefined}
                    className="flex-1"
                  >
                    {helpLabel(action.request, action.label)}
                  </Button>
                ))}
              </div>
            )}
          </div>
          <p className="mt-4 flex items-start gap-2 text-small text-neutral-500">
            <Icon name="info" size={14} className="mt-px shrink-0" />
            {hints
              ? "Try from memory first. Hints and the refresher are there when you need them — using either is recorded as assisted practice."
              : "Try from memory first. Opening the refresher is recorded as assisted practice."}
          </p>
        </>
      ) : (
        <div className="mt-6 flex flex-col items-start gap-3">
          <h3 ref={headingRef} tabIndex={-1} className="text-body-lg font-medium text-neutral-900 focus:outline-none">
            {result ? (result.correct ? "Correct." : "Not quite.") : "Not graded."}
          </h3>
          <p className="text-body text-neutral-700">
            {outcome.kind === "graded" ? EVIDENCE_TEXT[outcome.result.evidence.kind] : outcome.message}
          </p>
          <div className="flex flex-wrap gap-3">
            {offered.map((action) => (
              <Button key={action.request} size="md" variant="tertiary" disabled={busy} onClick={() => onHelp(action.request)}>
                {action.label}
              </Button>
            ))}
            <Button size="md" disabled={busy} onClick={onNext} iconRight={<Icon name="arrow-right" size={16} />}>
              {last ? "Finish review" : "Next question"}
            </Button>
          </div>
        </div>
      )}

      {failure && (
        <div className="mt-4 flex flex-col items-start gap-3 rounded-md border border-neutral-200 px-4 py-3">
          <p className="text-body text-neutral-900">{failure.message}</p>
          {failure.retry && (
            <Button size="md" variant="tertiary" onClick={failure.retry}>
              Try again
            </Button>
          )}
        </div>
      )}

      {item.refresher && (
        <Refresher
          refresher={item.refresher}
          answered={outcome !== null}
          busy={busy}
          onOpen={onRefresher}
        />
      )}
    </Card>
  );
}

/**
 * "Need a refresher?": the lesson moment the question cites. Expanding it
 * only explains what happens; following the link records it as help first
 * (the server issues the link), then opens the lesson at that second.
 */
function Refresher({
  refresher,
  answered,
  busy,
  onOpen,
}: {
  refresher: { lessonTitle: string; startSeconds: number };
  answered: boolean;
  busy: boolean;
  onOpen: () => void;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const clock = formatClock(refresher.startSeconds, { pad: true });

  return (
    <div className="mt-6 rounded-md border border-neutral-100 bg-neutral-50">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-3 rounded-md px-4 py-3 text-left focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:outline-none"
      >
        <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-full bg-primary-500 text-on-primary">
          <Icon name="play-solid" size={14} />
        </span>
        <span className="flex-1 text-body text-neutral-900">Need a refresher? Watch the source explanation</span>
        <span className="text-body text-neutral-500 tabular-nums">{clock}</span>
        <Icon name="chevron-down" size={16} className={cn("shrink-0 text-neutral-500 transition-transform", open && "rotate-180")} />
      </button>
      <div id={panelId} hidden={!open} className="px-4 pb-4 sm:pl-[60px]">
        <div className="flex flex-col items-start gap-3">
          <p className="text-body text-neutral-700">
            Opens “{refresher.lessonTitle}” at {clock}.
            {answered ? " Your answer is already saved." : " Watching it before you answer records this question as assisted practice."}
          </p>
          <Button size="md" variant="secondary" disabled={busy} onClick={onOpen} iconLeft={<Icon name="play" size={16} />}>
            Watch from {clock}
          </Button>
        </div>
      </div>
    </div>
  );
}
