"use client";

import { useEffect, useId, useRef, useState, type RefObject } from "react";
import posthog from "posthog-js";
import { Button, Icon, Status } from "@/components/ui";
import { cn } from "@/lib/cn";
import { newRequestKey, postLearnerJson } from "@/lib/lesson/api";
import { helpActions, type HelpActionRequest } from "@/lib/lesson/help-actions";
import type { AttemptResult, HelpResponse, IssueTaskResponse, LessonCheckKind, LessonCheckResponse } from "@/lib/learner/contracts";
import { useLessonPlayer, useReportActiveTask } from "./lesson-player";

/** Questions per sitting; fewer when the lesson has fewer reviewed ideas. */
const CHECK_SIZE = 3;

type Question = {
  kind: LessonCheckKind;
  task: IssueTaskResponse;
  /** Check questions are numbered; a follow-up keeps the number of the question it follows. */
  number: number;
  /** Questions in this sitting, from the server's count of unanswered ideas. */
  of: number | null;
  level: 0 | 1 | 2 | 3;
  hints: HelpResponse["hint"][];
  selected: string | null;
  confidence: number | null;
  /** Set on the first submit and reused by retries, so a retry can never record twice. */
  idempotencyKey: string | null;
  result: AttemptResult | null;
};

type View =
  | { step: "idle" }
  | { step: "loading" }
  | { step: "question"; question: Question }
  | { step: "none"; reason: "no_items" | "all_checked" | "no_variant" | "expired" | "withdrawn" | "answered_elsewhere" }
  | { step: "done"; answered: number };

type Failure = { message: string; retry: (() => void) | null };

const NONE_TEXT: Record<Extract<View, { step: "none" }>["reason"], string> = {
  no_items: "There are no reviewed questions for this lesson yet.",
  all_checked: "You've answered every reviewed question for this lesson.",
  no_variant:
    "There's no other reviewed question on this idea yet, so an independent check isn't available right now.",
  expired: "That question expired before it was answered.",
  withdrawn: "That question was withdrawn by the course team, so it wasn't graded.",
  answered_elsewhere: "That question was already answered, perhaps in another tab.",
};

const EVIDENCE_TEXT: Record<AttemptResult["evidence"]["kind"], string> = {
  independent: "You answered this on your own, so it counts as independent evidence.",
  assisted: "You used help on this question, so it counts as practice with help.",
  not_counted: "You've answered this question before, so it doesn't add new evidence.",
};

const CONFIDENCE = [
  [1, "Guessing"],
  [2, "Unsure"],
  [3, "Fairly sure"],
  [4, "Sure"],
  [5, "Certain"],
] as const;

function inviteKey(lessonId: string, lessonRev: string) {
  return `vertex:check-invite:${lessonId}:${lessonRev}`;
}

function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

function writeFlag(key: string) {
  try {
    window.localStorage.setItem(key, "shown");
  } catch {
    // Private mode or storage disabled: the invitation may show again, nothing else changes.
  }
}

/**
 * The lesson's understanding check (development plan §5 PR-7). The server
 * picks each question (`/api/lesson-check`), grades it (`/api/attempts`,
 * PR-4) and decides each hint (`/api/help`, PR-5); this card only renders
 * them. Confidence is optional and asked before the result. After a wrong or
 * assisted answer the learner can take an unseen reviewed question on the
 * same idea without hints, which is what produces independent evidence; when
 * none exists the card says so rather than repeating a question. A one-time,
 * dismissible invitation appears when the video reaches its completion
 * milestone. Playback never infers mastery. It renders inside the lesson's
 * "Quick check" activity tab, which is its visible heading, and reports the
 * open question to the tutor through `LessonPlayerProvider`.
 */
export function LessonCheck({
  lessonId,
  lessonSlug,
  courseSlug,
  lessonRev,
  hints,
}: {
  lessonId: string;
  lessonSlug: string;
  courseSlug: string | null;
  lessonRev: string;
  hints: boolean;
}) {
  const player = useLessonPlayer();
  const onActiveTaskChange = useReportActiveTask();
  const [view, setView] = useState<View>({ step: "idle" });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [invite, setInvite] = useState(false);
  const answeredInSitting = useRef(0);
  const viewRef = useRef(view);
  const focusRef = useRef<HTMLHeadingElement>(null);
  const id = useId();

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  const question = view.step === "question" ? view.question : null;
  // Only an unanswered question is shared with the tutor: help after grading cannot change it.
  const open = question && !question.result ? question : null;
  const activeTaskId = open?.task.taskInstanceId ?? null;
  const activeLabel = open ? (open.kind === "follow_up" ? "a fresh check question" : `check question ${open.number}`) : null;
  useEffect(() => {
    onActiveTaskChange(activeTaskId && activeLabel ? { taskInstanceId: activeTaskId, label: activeLabel } : null);
  }, [activeTaskId, activeLabel, onActiveTaskChange]);

  // New question or new result: move focus to its heading for keyboard and screen-reader users.
  const focusKey = question ? `${question.task.taskInstanceId}:${question.result ? "result" : "ask"}` : view.step;
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    focusRef.current?.focus();
  }, [focusKey]);

  useEffect(() => {
    if (!player) return;
    const key = inviteKey(lessonId, lessonRev);
    return player.onCompleted(() => {
      if (viewRef.current.step !== "idle" || readFlag(key)) return;
      writeFlag(key);
      setInvite(true);
    });
  }, [player, lessonId, lessonRev]);

  function update(change: (question: Question) => Question) {
    setView((current) => (current.step === "question" ? { step: "question", question: change(current.question) } : current));
  }

  async function next(kind: LessonCheckKind, afterTaskInstanceId?: string, number = answeredInSitting.current + 1) {
    setInvite(false);
    setFailure(null);
    setView({ step: "loading" });
    const result = await postLearnerJson<LessonCheckResponse>("/api/lesson-check", {
      lessonId,
      kind,
      ...(afterTaskInstanceId ? { afterTaskInstanceId } : {}),
    });
    if (!result.ok) {
      setView({ step: "idle" });
      setFailure({
        message: result.retryable ? "Couldn't load a question. Nothing was recorded." : "Couldn't load a question.",
        retry: result.retryable ? () => void next(kind, afterTaskInstanceId, number) : null,
      });
      return;
    }
    const body = result.data;
    if (body.status === "none") {
      setView({ step: "none", reason: body.reason });
      return;
    }
    const of = body.progress ? Math.min(CHECK_SIZE, answeredInSitting.current + body.progress.remaining) : null;
    setView({
      step: "question",
      question: {
        kind: body.kind,
        task: body.task,
        number,
        of,
        level: 0,
        hints: [],
        selected: null,
        confidence: null,
        idempotencyKey: null,
        result: null,
      },
    });
  }

  function start() {
    answeredInSitting.current = 0;
    void next("check");
  }

  function nextCheck() {
    if (answeredInSitting.current >= CHECK_SIZE) {
      setView({ step: "done", answered: answeredInSitting.current });
      return;
    }
    void next("check");
  }

  async function askHelp(current: Question, request: HelpActionRequest, requestKey = newRequestKey()) {
    setBusy(true);
    setFailure(null);
    const result = await postLearnerJson<HelpResponse>("/api/help", {
      taskInstanceId: current.task.taskInstanceId,
      mode: "study",
      request,
      requestKey,
    });
    setBusy(false);
    if (!result.ok) {
      setFailure({
        message:
          result.code === "hint_unavailable"
            ? "No reviewed help is available for this question."
            : result.retryable
              ? "Couldn't load help. Nothing was recorded."
              : "Couldn't load help.",
        retry: result.retryable ? () => void askHelp(current, request, requestKey) : null,
      });
      return;
    }
    const help = result.data;
    posthog.capture("hint_escalated", { source: "check", lesson_slug: lessonSlug, request, level: help.level });
    update((question) =>
      question.task.taskInstanceId === current.task.taskInstanceId
        ? {
            ...question,
            level: Math.max(question.level, help.level) as Question["level"],
            hints: question.hints.some((hint) => hint.level === help.hint.level) ? question.hints : [...question.hints, help.hint],
          }
        : question,
    );
  }

  async function submit(current: Question) {
    if (!current.selected || busy) return;
    const idempotencyKey = current.idempotencyKey ?? newRequestKey();
    update((question) => ({ ...question, idempotencyKey }));
    setBusy(true);
    setFailure(null);
    const result = await postLearnerJson<AttemptResult>("/api/attempts", {
      taskInstanceId: current.task.taskInstanceId,
      optionId: current.selected,
      ...(current.confidence ? { selfConfidence: current.confidence } : {}),
      idempotencyKey,
    });
    setBusy(false);
    if (!result.ok) {
      if (result.code === "expired") return setView({ step: "none", reason: "expired" });
      if (result.code === "task_unavailable") return setView({ step: "none", reason: "withdrawn" });
      if (result.code === "already_submitted") return setView({ step: "none", reason: "answered_elsewhere" });
      // The same key and body are resent, so a retry can only return the stored grade, never add one.
      setFailure({
        message: result.retryable
          ? "Your answer didn't reach us. Try again; it won't be counted twice."
          : "Couldn't submit your answer. Try again; it won't be counted twice.",
        retry: () => void submit({ ...current, idempotencyKey }),
      });
      return;
    }
    if (current.kind === "check") answeredInSitting.current += 1;
    posthog.capture("check_answered", {
      lesson_slug: lessonSlug,
      course_slug: courseSlug,
      check_kind: current.kind,
      question_number: current.number,
      confidence_given: current.confidence !== null,
    });
    update((question) => ({ ...question, result: result.data }));
  }

  return (
    <section aria-labelledby={`${id}-title`} className="ph-no-capture">
      {/* The "Quick check" tab is the visible heading; this names the region for screen readers. */}
      <h2 id={`${id}-title`} className="sr-only">
        Check your understanding
      </h2>

      {invite && view.step === "idle" && (
        <div
          role="status"
          className="flex flex-col gap-3 rounded-md border border-primary-300 bg-primary-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="text-body text-neutral-900">Finished the video? Try a few reviewed questions on it.</p>
          <div className="flex shrink-0 gap-3">
            <Button size="md" onClick={start}>
              Start the check
            </Button>
            <Button size="md" variant="text" onClick={() => setInvite(false)}>
              Not now
            </Button>
          </div>
        </div>
      )}

      <div className={cn(invite && view.step === "idle" && "mt-4")} aria-live="polite" aria-busy={view.step === "loading" || busy}>
        {view.step === "idle" && !invite && (
          <div className="flex flex-col items-start gap-3">
            <p className="text-body text-neutral-700">
              A few reviewed questions on this lesson. Your answers are private and never count against you.
            </p>
            <Button size="md" variant="secondary" onClick={start}>
              Start the check
            </Button>
          </div>
        )}

        {view.step === "loading" && <Status kind="in-progress" label="Loading a question…" />}

        {view.step === "none" && (
          <div className="flex flex-col items-start gap-3">
            <h3 ref={focusRef} tabIndex={-1} className="text-body-lg text-neutral-900 focus:outline-none">
              {NONE_TEXT[view.reason]}
            </h3>
            {view.reason === "expired" && (
              <Button size="md" variant="tertiary" onClick={() => void next("check")}>
                Get a new question
              </Button>
            )}
            {(view.reason === "no_variant" || view.reason === "withdrawn" || view.reason === "answered_elsewhere") && (
              <Button size="md" variant="tertiary" onClick={nextCheck}>
                Next question
              </Button>
            )}
          </div>
        )}

        {view.step === "done" && (
          <div className="flex flex-col items-start gap-3">
            <h3 ref={focusRef} tabIndex={-1} className="text-body-lg text-neutral-900 focus:outline-none">
              You answered {view.answered} {view.answered === 1 ? "question" : "questions"}.
            </h3>
            <Button size="md" variant="tertiary" onClick={start}>
              Keep going
            </Button>
          </div>
        )}

        {question && (
          <QuestionCard
            id={id}
            question={question}
            hints={hints}
            busy={busy}
            focusRef={focusRef}
            onSelect={(optionId) => update((q) => ({ ...q, selected: optionId }))}
            onConfidence={(confidence) => update((q) => ({ ...q, confidence }))}
            onHelp={(request) => void askHelp(question, request)}
            onSubmit={() => void submit(question)}
            onFollowUp={() => void next("follow_up", question.task.taskInstanceId, question.number)}
            onNext={nextCheck}
          />
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
      </div>
    </section>
  );
}

function QuestionCard({
  id,
  question,
  hints,
  busy,
  focusRef,
  onSelect,
  onConfidence,
  onHelp,
  onSubmit,
  onFollowUp,
  onNext,
}: {
  id: string;
  question: Question;
  hints: boolean;
  busy: boolean;
  focusRef: RefObject<HTMLHeadingElement | null>;
  onSelect: (optionId: string) => void;
  onConfidence: (confidence: number | null) => void;
  onHelp: (request: HelpActionRequest) => void;
  onSubmit: () => void;
  onFollowUp: () => void;
  onNext: () => void;
}) {
  const { task, result } = question;
  const followUp = question.kind === "follow_up";
  // A submit is in flight or awaiting retry: the answer is locked so a retry resends the same body.
  const locked = busy || question.idempotencyKey !== null;
  const solution = question.hints.find((hint) => hint.level === 3);
  const correctOptionId = solution?.level === 3 ? solution.correctOptionId : result?.correct ? question.selected : null;
  const offered = hints && (!followUp || result) ? helpActions({ level: question.level, answered: result !== null, correct: result?.correct }) : [];
  const independentCorrect = result?.correct && result.evidence.kind === "independent";

  return (
    <div className="flex flex-col gap-5">
      <p className="text-small tracking-wider text-neutral-500 uppercase">
        {followUp ? "Fresh question · no hints" : question.of ? `Question ${question.number} of ${question.of}` : `Question ${question.number}`}
      </p>

      {/* Wide enough (a container query on the activity panel): the answer on the left, confidence and actions in a rail. */}
      <div className={cn("flex flex-col gap-5", !result && "@xl:grid @xl:grid-cols-[minmax(0,1fr)_minmax(0,15rem)] @xl:gap-0")}>
        <div className={cn("flex min-w-0 flex-col gap-5", !result && "@xl:pr-6")}>
          <fieldset disabled={result !== null || locked} className="flex flex-col gap-3">
            <legend className="mb-3">
              <h3 ref={result ? undefined : focusRef} tabIndex={-1} className="text-body-lg font-medium text-neutral-900 focus:outline-none">
                {task.item.question}
              </h3>
            </legend>
            {task.item.options.map((option) => {
              const chosen = question.selected === option.id;
              const isCorrect = correctOptionId === option.id;
              return (
                <label
                  key={option.id}
                  className={cn(
                    "flex cursor-pointer items-center gap-3 rounded-md border px-4 py-3 text-body-lg text-neutral-900 transition-colors",
                    chosen ? "border-primary-400 bg-primary-100" : "border-neutral-200 hover:border-neutral-300",
                    result !== null && "cursor-default",
                  )}
                >
                  <input
                    type="radio"
                    name={`${id}-${task.taskInstanceId}`}
                    value={option.id}
                    checked={chosen}
                    onChange={() => onSelect(option.id)}
                    className="accent-primary-500"
                  />
                  <span className="flex-1">{option.text}</span>
                  {isCorrect && (
                    <span className="inline-flex items-center gap-1 text-small text-success">
                      <Icon name="check" size={14} /> Correct answer
                    </span>
                  )}
                </label>
              );
            })}
          </fieldset>

          {question.hints.length > 0 && (
            <div className="flex flex-col gap-2">
              {question.hints.map((hint) => (
                <div key={hint.level} className="rounded-md border border-neutral-200 px-4 py-3">
                  <p className="text-small tracking-wider text-neutral-500 uppercase">{hint.level === 3 ? "Explanation" : `Hint ${hint.level}`}</p>
                  <p className="mt-1 text-body-lg text-neutral-900">{hint.text}</p>
                </div>
              ))}
              {!result && solution && (
                <p className="text-small text-neutral-500">
                  You&apos;ve seen the answer, so this question will count as practice with help.
                </p>
              )}
            </div>
          )}
        </div>

        {!result && (
          <div className="flex min-w-0 flex-col gap-5 @xl:border-l @xl:border-neutral-200 @xl:pl-6">
            <fieldset disabled={locked} className="flex flex-col gap-2">
              <legend className="text-body text-neutral-700">How sure are you? (optional)</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {CONFIDENCE.map(([value, label]) => (
                  <label
                    key={value}
                    className={cn(
                      "cursor-pointer rounded-full border px-3 py-1 text-small transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary-400",
                      question.confidence === value
                        ? "border-primary-400 bg-primary-100 text-neutral-900"
                        : "border-neutral-200 text-neutral-700 hover:border-neutral-300",
                    )}
                  >
                    <input
                      type="radio"
                      name={`${id}-${task.taskInstanceId}-confidence`}
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

            <div className="flex flex-wrap gap-3 @xl:flex-col @xl:items-start">
              <Button size="md" onClick={onSubmit} disabled={!question.selected || locked} iconRight={<Icon name="arrow-right" size={16} />}>
                Check answer
              </Button>
              {offered.map((action) => (
                <Button key={action.request} size="md" variant="tertiary" disabled={busy} onClick={() => onHelp(action.request)}>
                  {action.label}
                </Button>
              ))}
            </div>
            {followUp && (
              <p className="text-small text-neutral-500">
                No hints on this one: it checks what you can do on your own. Asking the tutor now would count as help.
              </p>
            )}
          </div>
        )}
      </div>

      {result && (
        <div className="flex flex-col items-start gap-3">
          <h3 ref={focusRef} tabIndex={-1} className="text-body-lg font-medium text-neutral-900 focus:outline-none">
            {result.correct ? "Correct." : "Not quite."}
          </h3>
          <p className="text-body text-neutral-700">{EVIDENCE_TEXT[result.evidence.kind]}</p>
          <div className="flex flex-wrap gap-3">
            {offered.map((action) => (
              <Button key={action.request} size="md" variant="tertiary" disabled={busy} onClick={() => onHelp(action.request)}>
                {action.label}
              </Button>
            ))}
            {!independentCorrect && (
              <Button size="md" variant="secondary" disabled={busy} onClick={onFollowUp}>
                Try a fresh question without hints
              </Button>
            )}
            <Button size="md" variant={independentCorrect ? "secondary" : "text"} disabled={busy} onClick={onNext}>
              Next question
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
