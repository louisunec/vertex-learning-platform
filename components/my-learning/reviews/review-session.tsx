"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import posthog from "posthog-js";
import { Button, Card, Status } from "@/components/ui";
import { closedOnLoad, conceptProgress, formatDueDate, nextOpenPosition, type ActiveReview } from "@/lib/focused-review";
import { newRequestKey, postLearnerJson, type ApiResult } from "@/lib/lesson/api";
import type { HelpActionRequest } from "@/lib/lesson/help-actions";
import type {
  AttemptResult,
  HelpResponse,
  ReviewMode,
  ReviewRefresherResponse,
  ReviewSessionResponse,
  ScheduledReviewResponse,
} from "@/lib/learner/contracts";
import { QuestionCard, type Question } from "./question-card";
import { SessionSidebar } from "./session-sidebar";

type OpenItem = Extract<ActiveReview["items"][number], { state: "open" }>;

type StartResponse = ReviewSessionResponse | ScheduledReviewResponse;

type NoneText = { title: string; body: string };

type View =
  | { step: "loading" }
  | { step: "failed"; retryable: boolean }
  | { step: "none"; text: NoneText }
  | { step: "active"; session: ActiveReview; closed: ReadonlySet<number>; question: Question | null };

type Failure = { message: string; retry: (() => void) | null };

const NONE_TEXT: Record<Extract<ReviewSessionResponse, { status: "none" }>["reason"], NoneText> = {
  no_recent_mistakes: {
    title: "Nothing to review right now.",
    body: "Reviews come from questions you missed or answered with help in the last 30 days.",
  },
  no_unseen_questions: {
    title: "No new questions for the concepts you're working on.",
    body: "You've already answered every reviewed question on them, so a review wouldn't be a fresh, independent attempt. More appear as the course team reviews them.",
  },
};

/** Scheduled mode's empty states, with the next due date from the learner's stored schedule. */
function scheduledNoneText(body: Extract<ScheduledReviewResponse, { status: "none" }>): NoneText {
  const next = body.nextDueAt ? ` Your next review is due ${formatDueDate(body.nextDueAt)}.` : "";
  if (body.reason === "no_scheduled_questions") {
    return {
      title: "Reviews are due, but none has a question available right now.",
      body: `The reviewed questions for them were withdrawn or changed, so they stay due until one is available.${next}`,
    };
  }
  return {
    title: "No reviews due right now.",
    body: next
      ? next.trim()
      : "Reviews are scheduled as you answer reviewed questions in lessons and reviews. Nothing is scheduled yet.",
  };
}

function makeQuestion(item: OpenItem): Question {
  return {
    item,
    level: 0,
    hints: [],
    selected: null,
    confidence: null,
    idempotencyKey: null,
    outcome: null,
    refresherKey: null,
  };
}

/**
 * The focused review (prompts/focused-review.md). The server starts or
 * resumes the session (`/api/review-session`), grades each answer
 * (`/api/attempts`), decides each hint (`/api/help`), and records the
 * refresher before handing out its lesson link. This component only renders
 * them and remembers where the learner is; a reload resumes from the server.
 */
export function ReviewSession({ hints, mode = "mistakes" }: { hints: boolean; mode?: ReviewMode }) {
  const [view, setView] = useState<View>({ step: "loading" });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  /** Shows a start-or-resume response; the view is "loading" until then (initially, or via `reload`). */
  const apply = useCallback((result: ApiResult<StartResponse>) => {
    if (!result.ok) {
      setView({ step: "failed", retryable: result.retryable });
      return;
    }
    const body = result.data;
    if (body.status === "none") {
      setView({ step: "none", text: "mode" in body ? scheduledNoneText(body) : NONE_TEXT[body.reason] });
      return;
    }
    const session: ActiveReview = body;
    const closed = closedOnLoad(session);
    const first = nextOpenPosition(session, closed);
    posthog.capture("review_session_started", {
      mode: session.mode ?? "mistakes",
      resumed: session.resumed,
      questions: session.items.length,
      concepts: session.concepts.length,
      answered: closed.size,
    });
    setView({ step: "active", session, closed, question: first === null ? null : makeQuestion(openItem(session, first)) });
  }, []);

  useEffect(() => {
    // A repeated start (Strict Mode, a second tab) resumes the same session on the server.
    let cancelled = false;
    void startOrResume(mode).then((result) => {
      if (!cancelled) apply(result);
    });
    return () => {
      cancelled = true;
    };
  }, [apply, mode]);

  function reload() {
    setFailure(null);
    setView({ step: "loading" });
    void startOrResume(mode).then(apply);
  }

  const questionKey = view.step === "active" ? `${view.question?.item.position ?? "done"}:${view.question?.outcome ? "result" : "ask"}` : view.step;
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    headingRef.current?.focus();
  }, [questionKey]);

  function update(change: (question: Question) => Question) {
    setView((current) =>
      current.step === "active" && current.question ? { ...current, question: change(current.question) } : current,
    );
  }

  /** Closes the current position (answered or no longer answerable) without moving on. */
  function close(position: number, outcome: Question["outcome"]) {
    setView((current) =>
      current.step === "active" && current.question?.item.position === position
        ? { ...current, closed: new Set([...current.closed, position]), question: { ...current.question, outcome } }
        : current,
    );
  }

  function next() {
    setFailure(null);
    setView((current) => {
      if (current.step !== "active" || !current.question) return current;
      const position = nextOpenPosition(current.session, current.closed, current.question.item.position);
      return { ...current, question: position === null ? null : makeQuestion(openItem(current.session, position)) };
    });
  }

  async function askHelp(current: Question, request: HelpActionRequest, requestKey = newRequestKey()) {
    setBusy(true);
    setFailure(null);
    const result = await postLearnerJson<HelpResponse>("/api/help", {
      taskInstanceId: current.item.task.taskInstanceId,
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
    posthog.capture("hint_escalated", { source: "review", request, level: help.level });
    update((question) =>
      question.item.task.taskInstanceId === current.item.task.taskInstanceId
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
      taskInstanceId: current.item.task.taskInstanceId,
      optionId: current.selected,
      ...(current.confidence ? { selfConfidence: current.confidence } : {}),
      idempotencyKey,
    });
    setBusy(false);
    const { position } = current.item;
    if (!result.ok) {
      if (result.code === "expired") return close(position, { kind: "closed", message: "This question expired before it was answered, so it wasn't graded." });
      if (result.code === "task_unavailable") return close(position, { kind: "closed", message: "This question was withdrawn by the course team, so it wasn't graded." });
      if (result.code === "already_submitted") return close(position, { kind: "closed", message: "This question was already answered, perhaps in another tab." });
      // The same key and body are resent, so a retry can only return the stored grade, never add one.
      setFailure({
        message: result.retryable
          ? "Your answer didn't reach us. Try again; it won't be counted twice."
          : "Couldn't submit your answer. Try again; it won't be counted twice.",
        retry: () => void submit({ ...current, idempotencyKey }),
      });
      return;
    }
    posthog.capture("review_answered", {
      mode,
      question_number: position,
      confidence_given: current.confidence !== null,
      evidence_kind: result.data.evidence.kind,
      ...(result.data.schedule ? { schedule_status: result.data.schedule.status } : {}),
    });
    close(position, { kind: "graded", result: result.data });
  }

  async function openRefresher(current: Question) {
    const requestKey = current.refresherKey ?? newRequestKey();
    update((question) => ({ ...question, refresherKey: requestKey }));
    setBusy(true);
    setFailure(null);
    const result = await postLearnerJson<ReviewRefresherResponse>("/api/review-session/refresher", {
      taskInstanceId: current.item.task.taskInstanceId,
      requestKey,
    });
    if (!result.ok) {
      setBusy(false);
      setFailure({
        message: result.retryable ? "Couldn't open the refresher. Try again." : "The refresher isn't available for this question.",
        retry: result.retryable ? () => void openRefresher({ ...current, refresherKey: requestKey }) : null,
      });
      return;
    }
    posthog.capture("review_refresher_opened", { question_number: current.item.position, answered: current.outcome !== null });
    // Leaving is safe: the session and any answer are stored, and this page resumes them.
    window.location.assign(result.data.href);
  }

  if (view.step === "loading") {
    return (
      <div className="mt-10" aria-live="polite" aria-busy="true">
        <Status kind="in-progress" label="Loading your review…" />
      </div>
    );
  }

  if (view.step === "failed") {
    return (
      <Card className="mt-10 flex flex-col items-start gap-4 p-6">
        <p className="text-body-lg text-neutral-700">
          {view.retryable ? "Your review couldn't be loaded. Nothing was recorded." : "Your review couldn't be loaded."}
        </p>
        <Button size="md" variant="tertiary" onClick={reload}>
          Try again
        </Button>
      </Card>
    );
  }

  if (view.step === "none") {
    const { text } = view;
    return (
      <Card className="mt-10 flex flex-col items-start gap-3 p-6">
        <h2 className="text-body-lg font-medium text-neutral-900">{text.title}</h2>
        <p className="text-body text-neutral-500">{text.body}</p>
        <Button href="/my-learning" size="md" variant="tertiary" className="mt-2">
          Back to My Learning
        </Button>
      </Card>
    );
  }

  const { session, closed, question } = view;
  const current = question?.item.position ?? null;
  const currentConcept = session.concepts.find((concept) => concept.conceptId === question?.item.conceptId) ?? null;

  return (
    <div className="mt-10 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_330px]">
      <div aria-live="polite" aria-busy={busy}>
        {question ? (
          <QuestionCard
            key={question.item.position}
            question={question}
            total={session.items.length}
            concept={currentConcept}
            hints={hints}
            busy={busy}
            failure={failure}
            headingRef={headingRef}
            onSelect={(optionId) => update((q) => ({ ...q, selected: optionId }))}
            onConfidence={(confidence) => update((q) => ({ ...q, confidence }))}
            onHelp={(request) => void askHelp(question, request)}
            onSubmit={() => void submit(question)}
            onRefresher={() => void openRefresher(question)}
            onNext={next}
            last={nextOpenPosition(session, closed, question.item.position) === null}
          />
        ) : (
          <Card className="flex flex-col items-start gap-3 p-6">
            <h2 ref={headingRef} tabIndex={-1} className="text-body-lg font-medium text-neutral-900 focus:outline-none">
              Review complete.
            </h2>
            <p className="text-body text-neutral-500">
              {session.mode === "scheduled"
                ? "Your answers are saved, and each one set when that concept comes back. Answers given with help leave the schedule as it was."
                : "Your answers are saved to your learning evidence. Concepts you still miss can come back in a later review."}
            </p>
            <div className="mt-2 flex flex-wrap gap-3">
              <Button href="/my-learning" size="md" variant="tertiary">
                Back to My Learning
              </Button>
              <Button size="md" variant="text" onClick={reload}>
                Start another review
              </Button>
            </div>
          </Card>
        )}
      </div>
      <SessionSidebar
        summary={session}
        progress={conceptProgress(session, closed, current)}
        reason={currentConcept?.reason ?? null}
      />
    </div>
  );
}

/** Mistakes sends the same empty body as before PR-9; only the scheduled mode names itself. */
function startOrResume(mode: ReviewMode) {
  return postLearnerJson<StartResponse>("/api/review-session", mode === "scheduled" ? { mode } : {});
}

function openItem(session: ActiveReview, position: number): OpenItem {
  const item = session.items.find((candidate) => candidate.position === position);
  if (!item || item.state !== "open") throw new Error(`Review item ${position} is not open`);
  return item;
}
