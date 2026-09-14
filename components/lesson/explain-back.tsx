"use client";

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type RefObject } from "react";
import Link from "next/link";
import posthog from "posthog-js";
import { Badge, Button, Icon, Status, type IconName } from "@/components/ui";
import { cn } from "@/lib/cn";
import type { CriterionFeedback, CriterionStatus, ExplainResponse, LearnerExplainTaskView } from "@/lib/explain/contracts";
import { evidenceNote, statusText, summarizeFeedback } from "@/lib/explain/present";
import { MAX_EXPLANATION_CHARS, MIN_EXPLANATION_CHARS, normalizeExplanation } from "@/lib/explain/text";
import { citationText, groupCitations } from "@/lib/lesson/citations";
import { newRequestKey, postLearnerJson } from "@/lib/lesson/api";
import { useLessonPlayer } from "./lesson-player";

/** One `/api/explain` call; a retry resends it unchanged, so the server can never record it twice. */
type Call = { text: string; idempotencyKey: string };

type Failure = { call: Call; code: string; retryable: boolean };

/** The feedback on screen and the exact text it judged (spans refer to it). */
type Shown = { response: ExplainResponse; text: string };

/** Another request with this key holds the claim; wait for it rather than paying twice. */
const IN_PROGRESS_RETRIES = 8;
const IN_PROGRESS_DELAY_MS = 4000;

const STATUS_LOOK: Record<CriterionStatus, { icon: IconName; className: string }> = {
  demonstrated: { icon: "check-circle", className: "text-success" },
  missing: { icon: "target", className: "text-neutral-500" },
  unclear: { icon: "eye", className: "text-neutral-500" },
  contradicted: { icon: "target", className: "text-lesson" },
  insufficient_evidence: { icon: "bulb", className: "text-neutral-500" },
  not_validated: { icon: "refresh", className: "text-neutral-500" },
};

function failureText(code: string): string {
  switch (code) {
    case "network":
    case "unavailable":
      return "Feedback is unavailable right now. Your explanation is still here and nothing was recorded, so you can try again.";
    case "explanation_in_progress":
      return "Your explanation is still being read. Try again in a moment.";
    case "rate_limited":
      return "You've reached this hour's limit for feedback. Your explanation is still here; try again later.";
    case "task_unavailable":
      return "This question changed since the page loaded. Copy your explanation, then reload the page to see the current question.";
    case "payload_too_large":
      return `That's longer than feedback can take (${MAX_EXPLANATION_CHARS.toLocaleString()} characters).`;
    case "invalid_request":
      return `Write at least ${MIN_EXPLANATION_CHARS} characters, without unusual control characters.`;
    case "not_found":
      return "This step isn't available for this lesson.";
    case "unauthenticated":
      return "Your session has ended. Sign in again; your explanation is still here.";
    default:
      return "Something went wrong. Please try again later.";
  }
}

function skipKey(task: LearnerExplainTaskView) {
  return `vertex:explain-skip:${task.taskId}:${task.version}`;
}

function readSkipped(key: string): boolean {
  try {
    return window.localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

const skipListeners = new Set<() => void>();

function subscribeSkipped(listener: () => void) {
  skipListeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    skipListeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function writeSkipped(key: string) {
  try {
    window.localStorage.setItem(key, "skipped");
  } catch {
    // Private mode or storage disabled: the step just shows as unopened next time.
  }
  for (const listener of skipListeners) listener();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The optional "Explain it in your own words" step after practice
 * (development plan §5 PR-8), over `/api/explain`. The learner answers one
 * narrow question; feedback says what the explanation shows, what is
 * missing or unclear, and where it disagrees with the lesson, with lesson
 * moments that seek in place. The text field is never cleared, so a failure
 * or a revision never loses work. No text or feedback goes to analytics or
 * session replay (`ph-no-capture`), and nothing here is a grade.
 *
 * `embedded` renders the body open, without the collapsible card, for the
 * lesson page's "Explain it back" activity tab (lesson-page integration):
 * the tab label is the heading, so the body shows the task's title.
 */
export function ExplainBack({
  task,
  lessonSlug,
  courseSlug,
  embedded = false,
}: {
  task: LearnerExplainTaskView;
  lessonSlug: string;
  courseSlug: string | null;
  embedded?: boolean;
}) {
  const player = useLessonPlayer();
  const [open, setOpen] = useState(false);
  // Remembered per task version in this browser only; the server render never knows, so it starts unskipped.
  const skipped = useSyncExternalStore(subscribeSkipped, () => readSkipped(skipKey(task)), () => false);
  const [text, setText] = useState("");
  const [pending, setPending] = useState<Call | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const panelId = useId();
  const textId = useId();
  const hintId = useId();
  const textRef = useRef<HTMLTextAreaElement>(null);
  const resultRef = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (shown) resultRef.current?.focus();
  }, [shown]);

  const normalized = useMemo(() => normalizeExplanation(text), [text]);
  const edited = shown !== null && (!normalized.ok || normalized.text !== shown.text);

  async function send(call: Call) {
    setPending(call);
    setFailure(null);
    const body = { lessonId: task.lessonId, taskId: task.taskId, taskVersion: task.version, text: call.text, idempotencyKey: call.idempotencyKey };
    let result = await postLearnerJson<ExplainResponse>("/api/explain", body);
    for (let attempt = 0; !result.ok && result.code === "explanation_in_progress" && attempt < IN_PROGRESS_RETRIES && mounted.current; attempt++) {
      await sleep(IN_PROGRESS_DELAY_MS);
      result = await postLearnerJson<ExplainResponse>("/api/explain", body);
    }
    if (!mounted.current) return;
    setPending(null);

    const counts = result.ok ? countStatuses(result.data.criteria) : null;
    posthog.capture("explanation_submitted", {
      lesson_slug: lessonSlug,
      course_slug: courseSlug,
      task_id: task.taskId,
      task_version: task.version,
      outcome: result.ok ? result.data.outcome : null,
      attempt_number: result.ok ? result.data.attempt.number : null,
      cached: result.ok ? result.data.attempt.cached : null,
      evidence_kind: result.ok ? result.data.attempt.evidence.kind : null,
      evidence_reason: result.ok ? result.data.attempt.evidence.reason : null,
      ...(counts ?? {}),
      error_code: result.ok ? null : result.code,
    });

    if (!result.ok) {
      setFailure({ call, code: result.code, retryable: result.retryable });
      return;
    }
    const judged = normalizeExplanation(call.text);
    setShown({ response: result.data, text: judged.ok ? judged.text : call.text });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!normalized.ok || pending) return;
    // A retry of the same text reuses its key, so it can only return the stored result.
    const reuse = failure !== null && failure.code !== "idempotency_key_reused" && failure.call.text === text;
    void send({ text, idempotencyKey: reuse ? failure.call.idempotencyKey : newRequestKey() });
  }

  function skip() {
    writeSkipped(skipKey(task));
    setOpen(false);
    posthog.capture("explanation_skipped", { lesson_slug: lessonSlug, course_slug: courseSlug, task_id: task.taskId, task_version: task.version, had_feedback: shown !== null });
  }

  function revise() {
    const field = textRef.current;
    if (!field) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    field.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
  }

  const counter = normalized.ok
    ? `${normalized.charCount.toLocaleString()} of ${MAX_EXPLANATION_CHARS.toLocaleString()} characters`
    : normalized.problem === "too_long"
      ? `Over the ${MAX_EXPLANATION_CHARS.toLocaleString()}-character limit`
      : normalized.problem === "control_characters"
        ? "Remove the unusual control characters to send"
        : `A few sentences is plenty (at least ${MIN_EXPLANATION_CHARS} characters)`;

  const response = shown?.response ?? null;

  const body = (
    <>
      <div className="flex flex-col gap-2">
        {embedded && <h3 className="font-display text-h3 text-neutral-900">{task.title}</h3>}
        <Badge variant="video">Optional</Badge>
        <p className="text-body-lg whitespace-pre-line text-neutral-900">{task.prompt}</p>
        <p className="text-body text-neutral-500">
          Use your own words; you don&apos;t need the lesson&apos;s exact terms. This isn&apos;t graded and doesn&apos;t change your progress.
        </p>
        {embedded && skipped && !shown && <p className="text-small text-neutral-500">Skipped for now. Come back to it any time.</p>}
      </div>

      <form onSubmit={submit} className="flex flex-col gap-3">
        <label htmlFor={textId} className="text-body font-medium text-neutral-900">
          Your explanation
        </label>
        <textarea
          id={textId}
          ref={textRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          readOnly={pending !== null}
          aria-describedby={hintId}
          rows={6}
          placeholder="Explain it as you would to a classmate."
          className="w-full resize-y rounded-md border border-neutral-200 bg-canvas px-4 py-3 text-body-lg text-neutral-900 transition-colors placeholder:text-neutral-500 focus:border-primary-400 focus:outline-none"
        />
        <div id={hintId} className="flex flex-col gap-1 text-small text-neutral-500">
          <span className={cn(!normalized.ok && text.trim().length > 0 && normalized.problem !== "too_short" && "text-lesson")}>{counter}</span>
          <span>
            Your explanation is sent to our AI provider to give feedback, and saved privately to your account. It isn&apos;t used in
            analytics.
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="md" disabled={pending !== null || !normalized.ok}>
            {shown ? "Get feedback on your revision" : "Get feedback"}
          </Button>
          <Button type="button" size="md" variant="text" onClick={skip} disabled={pending !== null}>
            {shown ? "Done for now" : "Skip for now"}
          </Button>
          {edited && <span className="text-small text-neutral-500">You&apos;ve changed your explanation since this feedback.</span>}
        </div>
      </form>

      <div aria-live="polite" aria-busy={pending !== null} className="flex flex-col gap-4">
        {pending && <Status kind="in-progress" label="Reading your explanation… this can take up to 30 seconds." />}

        {failure && !pending && (
          <div className="flex flex-col items-start gap-3 rounded-md border border-neutral-200 px-4 py-3">
            <p className="text-body text-neutral-900">{failureText(failure.code)}</p>
            {failure.retryable && failure.code !== "rate_limited" && (
              <Button size="md" variant="tertiary" onClick={() => void send(failure.call)}>
                Try again
              </Button>
            )}
          </div>
        )}

        {shown && response && (
          <FeedbackResult
            response={response}
            text={shown.text}
            lessonId={task.lessonId}
            headingRef={resultRef}
            onSeek={(seconds) => player?.seekTo(seconds) ?? false}
            onRevise={revise}
          />
        )}
      </div>
    </>
  );

  if (embedded) return <div className="ph-no-capture flex flex-col gap-6">{body}</div>;

  return (
    <section className="ph-no-capture mt-6 rounded-[20px] border border-neutral-200 bg-surface">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-center justify-between gap-4 rounded-[20px] px-6 py-4 text-left focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:outline-none"
      >
        <span className="flex items-center gap-3">
          <Icon name="message" size={20} className="shrink-0 text-primary-500" />
          <span>
            <span className="block font-display text-h3 text-neutral-900">Explain it in your own words</span>
            <span className="block text-body text-neutral-500">
              {shown ? "Your feedback is below." : skipped ? "Skipped for now. Open it any time." : "Optional · a few sentences, then feedback on the key points."}
            </span>
          </span>
        </span>
        <Icon name="chevron-down" size={20} className={cn("shrink-0 text-neutral-500 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div id={panelId} className="flex flex-col gap-6 border-t border-neutral-200 px-6 pt-5 pb-6">
          {body}
        </div>
      )}
    </section>
  );
}

function countStatuses(criteria: readonly CriterionFeedback[]) {
  const required = criteria.filter((criterion) => criterion.required);
  const count = (status: CriterionStatus) => required.filter((criterion) => criterion.status === status).length;
  return {
    required_demonstrated: count("demonstrated"),
    required_missing: count("missing"),
    required_unclear: count("unclear"),
    required_contradicted: count("contradicted"),
    required_insufficient_evidence: count("insufficient_evidence"),
    required_not_validated: count("not_validated"),
  };
}

function FeedbackResult({
  response,
  text,
  lessonId,
  headingRef,
  onSeek,
  onRevise,
}: {
  response: ExplainResponse;
  text: string;
  lessonId: string;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onSeek: (seconds: number) => boolean;
  onRevise: () => void;
}) {
  const summary = summarizeFeedback(response);
  const note = evidenceNote(response.attempt);

  return (
    <article className="flex flex-col gap-4 rounded-md border border-neutral-200 px-4 py-4">
      <div>
        <p className="text-small tracking-wider text-neutral-500 uppercase">
          Feedback{response.attempt.number > 1 ? ` · attempt ${response.attempt.number}` : ""}
        </p>
        <h3 ref={headingRef} tabIndex={-1} className="mt-1 font-display text-h3 text-neutral-900 focus:outline-none">
          {summary.title}
        </h3>
        <p className="mt-1 text-body text-neutral-700">{summary.detail}</p>
        {note && <p className="mt-1 text-small text-neutral-500">{note}</p>}
      </div>

      {response.criteria.length > 0 && (
        <ul className="flex flex-col gap-4">
          {response.criteria.map((criterion) => {
            const look = STATUS_LOOK[criterion.status];
            const quote = criterion.span ? text.slice(criterion.span.start, criterion.span.end) : null;
            const citationLead =
              criterion.status === "contradicted" ? "What the lesson says:" : criterion.status === "demonstrated" ? null : "Where the lesson covers this:";
            return (
              <li key={criterion.criterionId} className="flex flex-col gap-2 border-t border-neutral-200 pt-4 first:border-t-0 first:pt-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn("inline-flex items-center gap-1.5 text-small font-medium", look.className)}>
                    <Icon name={look.icon} size={16} aria-hidden />
                    {statusText(criterion)}
                  </span>
                  {!criterion.required && <Badge variant="video">Optional</Badge>}
                </div>
                <p className="text-body-lg font-medium text-neutral-900">{criterion.label}</p>
                {quote && (
                  <blockquote className="border-l-2 border-neutral-300 pl-3 text-body text-neutral-700">
                    <span className="sr-only">You wrote: </span>“{quote}”
                  </blockquote>
                )}
                {criterion.feedback && <p className="text-body text-neutral-700">{criterion.feedback}</p>}
                {criterion.citations.length > 0 && citationLead && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-small text-neutral-500">{citationLead}</span>
                    {groupCitations(criterion.citations).map((group) => {
                      const here = group.lessonId === lessonId;
                      const label = citationText(group, lessonId);
                      return (
                        <Link
                          key={group.chunkIds.join(" ")}
                          href={group.href}
                          onClick={(event) => {
                            if (here && onSeek(group.startSeconds)) event.preventDefault();
                          }}
                          aria-label={here ? `Play the video from ${label}` : `Open ${label}`}
                          className="inline-flex items-center gap-1.5 rounded-full border border-neutral-200 px-3 py-1 text-small text-neutral-700 transition-colors hover:border-primary-400 hover:text-primary-500 focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:outline-none"
                        >
                          <Icon name={here ? "play-solid" : "arrow-right"} size={12} />
                          {label}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {response.followUpQuestion && (
        <div className="rounded-md border border-primary-300 bg-primary-100 px-4 py-3">
          <p className="text-small tracking-wider text-neutral-500 uppercase">A question to think about</p>
          <p className="mt-1 text-body-lg text-neutral-900">{response.followUpQuestion}</p>
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        <Button size="md" variant="secondary" onClick={onRevise}>
          Revise your explanation
        </Button>
      </div>

      <p className="text-small text-neutral-500">
        Feedback from an AI model, checked against this lesson&apos;s key points. It can be wrong, it isn&apos;t a grade, and it doesn&apos;t
        change your progress. Leaving a point out isn&apos;t counted as a mistake.
      </p>
    </article>
  );
}
