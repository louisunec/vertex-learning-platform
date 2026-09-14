"use client";

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import posthog from "posthog-js";
import { Badge, Button, Icon, Status } from "@/components/ui";
import { cn } from "@/lib/cn";
import { citationText, groupCitations } from "@/lib/lesson/citations";
import { newRequestKey, postLearnerJson } from "@/lib/lesson/api";
import { reviewHelpActions, type ReviewHelpRequestKind } from "@/lib/lesson/review-actions";
import {
  HELP_WORTHY_CATEGORIES,
  LANGUAGE_LABELS,
  type CriterionStatus,
  type FindingCategory,
  type LearnerTaskView,
  type PresentedFinding,
  type ReviewResponse,
} from "@/lib/submissions/contracts";
import { lineRangeText, MAX_SUBMISSION_CHARS, MAX_SUBMISSION_LINES, normalizeSubmission } from "@/lib/submissions/text";
import { useLessonPlayer } from "./lesson-player";

/** One `/api/review` call; a retry resends it unchanged, so the server cannot record it twice. */
type ReviewCall =
  | { action: "review"; content: string; requestKey: string }
  | { action: "help"; reviewId: string; request: ReviewHelpRequestKind; requestKey: string };

type Failure = { call: ReviewCall; code: string; retryable: boolean };

/** The review on screen and the exact code it judged (line numbers refer to it). */
type Shown = { response: ReviewResponse; lines: string[]; content: string };

/** A concurrent identical review holds the claim; wait for it rather than paying twice. */
const IN_PROGRESS_RETRIES = 8;
const IN_PROGRESS_DELAY_MS = 4000;

const CATEGORY: Record<FindingCategory, string> = {
  defect: "Problem",
  requirement_mismatch: "Criterion not met",
  alternative_valid: "Valid alternative",
  uncertain: "Couldn't tell",
};

const CRITERION: Record<CriterionStatus, { label: string; icon: "check-circle" | "target" | "eye"; className: string }> = {
  met: { label: "Looks met", icon: "check-circle", className: "text-success" },
  not_met: { label: "Not met", icon: "target", className: "text-lesson" },
  unclear: { label: "Couldn't tell", icon: "eye", className: "text-neutral-500" },
};

function outcomeText(response: ReviewResponse, language: string): { title: string; detail: string } {
  switch (response.outcome) {
    case "changes_suggested":
      return { title: "Changes suggested", detail: "The review found something to fix against the task's criteria." };
    case "partly_judged":
      return {
        title: "Partly reviewed",
        detail:
          response.findings.length > 0
            ? "Some of it couldn't be judged from the code alone. The notes below say what was unclear."
            : "Some criteria couldn't be judged from the code alone; they're marked above.",
      };
    case "no_issues_found":
      return {
        title: "No problems found against these criteria",
        detail: "That's a model's reading of your code, not a test run: it doesn't prove the code is correct.",
      };
    case "cannot_judge":
      switch (response.cannotJudgeReason) {
        case "incomplete_submission":
          return { title: "Couldn't review this yet", detail: "It looks incomplete. Include the whole function the task asks for." };
        case "off_task":
          return { title: "Couldn't review this", detail: "It doesn't look like an answer to this task." };
        case "unsupported_language":
          return { title: "Couldn't review this", detail: `The task asks for ${language}; this looks like another language.` };
        default:
          return {
            title: "Not enough to judge",
            detail: "There isn't enough here to judge the criteria. Include the code the task asks for, not just part of it.",
          };
      }
  }
}

function failureText(code: string): string {
  switch (code) {
    case "network":
    case "unavailable":
      return "The review is unavailable right now. Your code is still here and nothing was recorded, so you can try again.";
    case "review_in_progress":
      return "This code is still being reviewed. Try again in a moment.";
    case "rate_limited":
      return "You've reached this hour's limit of reviews. Your code is still here; try again later.";
    case "task_unavailable":
      return "This task changed since the page loaded. Copy your code, then reload the page to see the current task.";
    case "payload_too_large":
      return `That's longer than a review can take (${MAX_SUBMISSION_CHARS.toLocaleString()} characters, ${MAX_SUBMISSION_LINES} lines).`;
    case "invalid_request":
      return "The review couldn't take that code. Check that it isn't empty.";
    case "hint_unavailable":
      return "There's nothing more to explain in this review.";
    case "not_found":
      return "Review isn't available for this lesson.";
    case "unauthenticated":
      return "Your session has ended. Sign in again; your code is still here.";
    default:
      return "Something went wrong. Please try again later.";
  }
}

function evidenceNote(response: ReviewResponse): string | null {
  const submission = response.submission;
  if (!submission) return null;
  if (submission.evidence.reason === "repeat_submission") return "You submitted this exact code before, so this is the same review.";
  if (submission.evidence.kind === "assisted") return "You'd already had help on this task, so this counts as assisted practice.";
  return null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The lesson's code task (development plan §5 PR-12) over `/api/review`. The
 * learner writes code against the task's criteria and gets findings tied to
 * their own lines. More help is asked for explicitly; the server decides and
 * records the level. The code field is never cleared, so a failed request or
 * a revision never loses work. No code or feedback text goes to analytics or
 * session replay (`ph-no-capture`).
 */
export function SubmissionReview({
  task,
  lessonSlug,
  courseSlug,
}: {
  task: LearnerTaskView;
  lessonSlug: string;
  courseSlug: string | null;
}) {
  const player = useLessonPlayer();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [pending, setPending] = useState<ReviewCall | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [focusedFinding, setFocusedFinding] = useState<string | null>(null);
  const panelId = useId();
  const codeId = useId();
  const codeHintId = useId();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const normalized = useMemo(() => normalizeSubmission(code), [code]);
  const language = LANGUAGE_LABELS[task.language];
  const criterionText = useMemo(() => new Map(task.criteria.map((criterion) => [criterion.id, criterion.text])), [task.criteria]);

  async function send(call: ReviewCall) {
    setPending(call);
    setFailure(null);
    const body =
      call.action === "review"
        ? {
            action: "review",
            lessonId: task.lessonId,
            taskId: task.taskId,
            taskVersion: task.version,
            submission: { type: "snippet", content: call.content },
            requestKey: call.requestKey,
          }
        : { action: "help", reviewId: call.reviewId, request: call.request, requestKey: call.requestKey };

    let result = await postLearnerJson<ReviewResponse>("/api/review", body);
    for (let attempt = 0; !result.ok && result.code === "review_in_progress" && attempt < IN_PROGRESS_RETRIES && mounted.current; attempt++) {
      await sleep(IN_PROGRESS_DELAY_MS);
      result = await postLearnerJson<ReviewResponse>("/api/review", body);
    }
    if (!mounted.current) return;
    setPending(null);

    posthog.capture(call.action === "review" ? "submission_reviewed" : "hint_escalated", {
      source: "submission_review",
      lesson_slug: lessonSlug,
      course_slug: courseSlug,
      task_id: task.taskId,
      task_version: task.version,
      ...(call.action === "help" ? { request: call.request } : {}),
      outcome: result.ok ? result.data.outcome : null,
      cached: result.ok ? (result.data.submission?.cached ?? null) : null,
      finding_count: result.ok ? result.data.findings.length : null,
      help_level: result.ok ? result.data.help.level : null,
      evidence_kind: result.ok ? (result.data.submission?.evidence.kind ?? null) : null,
      error_code: result.ok ? null : result.code,
    });

    if (!result.ok) {
      setFailure({ call, code: result.code, retryable: result.retryable });
      return;
    }
    if (call.action === "review") {
      const judged = normalizeSubmission(call.content);
      const content = judged.ok ? judged.value.content : call.content;
      setShown({ response: result.data, lines: content.split("\n"), content });
    } else {
      // Same code, more of the same review.
      setShown((previous) => (previous ? { ...previous, response: result.data } : previous));
    }
    setFocusedFinding(null);
  }

  function review(event: FormEvent) {
    event.preventDefault();
    if (!normalized.ok || pending) return;
    void send({ action: "review", content: code, requestKey: newRequestKey() });
  }

  const response = shown?.response ?? null;
  const edited = shown !== null && (!normalized.ok || normalized.value.content !== shown.content);
  const helpWorthy = response?.findings.some((finding) => HELP_WORTHY_CATEGORIES.has(finding.category)) ?? false;
  const actions = response && !edited ? reviewHelpActions({ level: response.help.level, helpWorthy }) : [];
  const flagged = useMemo(() => {
    const lines = new Set<number>();
    for (const finding of response?.findings ?? []) {
      if (finding.category === "alternative_valid") continue;
      for (let line = finding.lines.start; line <= finding.lines.end; line++) lines.add(line);
    }
    return lines;
  }, [response]);
  const focused = response?.findings.find((finding) => finding.id === focusedFinding) ?? null;

  const counter = normalized.ok
    ? `${normalized.value.lineCount} of ${MAX_SUBMISSION_LINES} lines · ${normalized.value.charCount.toLocaleString()} of ${MAX_SUBMISSION_CHARS.toLocaleString()} characters`
    : normalized.problem === "too_long"
      ? `Over the ${MAX_SUBMISSION_CHARS.toLocaleString()}-character limit`
      : normalized.problem === "too_many_lines"
        ? `Over the ${MAX_SUBMISSION_LINES}-line limit`
        : normalized.problem === "control_characters"
          ? "Remove the unusual control characters to submit"
          : "Paste or write your code to submit";

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
          <Icon name="document" size={20} className="shrink-0 text-primary-500" />
          <span>
            <span className="block font-display text-h3 text-neutral-900">Build it: {task.title}</span>
            <span className="block text-body text-neutral-500">Write the code, then get feedback on your own lines.</span>
          </span>
        </span>
        <Icon name="chevron-down" size={20} className={cn("shrink-0 text-neutral-500 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div id={panelId} className="flex flex-col gap-6 border-t border-neutral-200 px-6 pt-5 pb-6">
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="video">{language}</Badge>
              <span className="text-small text-neutral-500">Task version {task.version}</span>
            </div>
            <p className="text-body-lg whitespace-pre-line text-neutral-900">{task.instructions}</p>
            <div>
              <h3 className="text-body font-medium text-neutral-900">Acceptance criteria</h3>
              <ul className="mt-2 flex flex-col gap-2">
                {task.criteria.map((criterion) => {
                  const status = response && !edited ? response.criteria.find((entry) => entry.criterionId === criterion.id)?.status : undefined;
                  const look = status ? CRITERION[status] : null;
                  return (
                    <li key={criterion.id} className="flex items-start gap-3 text-body text-neutral-700">
                      <Icon
                        name={look?.icon ?? "check"}
                        size={16}
                        className={cn("mt-1 shrink-0", look?.className ?? "text-neutral-300")}
                        aria-hidden
                      />
                      <span>
                        {criterion.text}
                        {look && <span className={cn("ml-2 text-small", look.className)}>{look.label}</span>}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>

          <form onSubmit={review} className="flex flex-col gap-3">
            <label htmlFor={codeId} className="text-body font-medium text-neutral-900">
              Your code
            </label>
            <textarea
              id={codeId}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              aria-describedby={codeHintId}
              rows={12}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              placeholder={`Write your ${language} here`}
              className="w-full resize-y rounded-md border border-neutral-200 bg-canvas px-4 py-3 font-mono text-body text-neutral-900 transition-colors placeholder:text-neutral-500 focus:border-primary-400 focus:outline-none"
            />
            <div id={codeHintId} className="flex flex-col gap-1 text-small text-neutral-500">
              <span className={cn(!normalized.ok && code.length > 0 && "text-lesson")}>{counter}</span>
              <span>
                Your code is sent to our AI provider to review it. Vertex keeps a fingerprint of the code and the feedback, not the code
                itself.
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" size="md" disabled={pending !== null || !normalized.ok}>
                {shown ? "Review again" : "Review my code"}
              </Button>
              {edited && <span className="text-small text-neutral-500">You&apos;ve changed your code since the review below.</span>}
            </div>
          </form>

          <div aria-live="polite" aria-busy={pending !== null} className="flex flex-col gap-4">
            {pending && (
              <Status kind="in-progress" label={pending.action === "review" ? "Reviewing your code… this can take up to a minute." : "Getting more help…"} />
            )}

            {failure && !pending && (
              <div className="flex flex-col items-start gap-3 rounded-md border border-neutral-200 px-4 py-3">
                <p className="text-body text-neutral-900">{failureText(failure.code)}</p>
                {failure.code === "idempotency_key_reused" ? (
                  <Button size="md" variant="tertiary" onClick={() => void send({ ...failure.call, requestKey: newRequestKey() })}>
                    Try again
                  </Button>
                ) : failure.retryable && failure.code !== "rate_limited" ? (
                  <Button size="md" variant="tertiary" onClick={() => void send(failure.call)}>
                    Try again
                  </Button>
                ) : null}
              </div>
            )}

            {shown && response && (
              <ReviewResult
                response={response}
                lines={shown.lines}
                flagged={flagged}
                focused={focused}
                language={language}
                criterionText={criterionText}
                lessonId={task.lessonId}
                onFocusFinding={setFocusedFinding}
                onSeek={(seconds) => player?.seekTo(seconds) ?? false}
              />
            )}

            {shown && response && actions.length > 0 && !pending && (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap gap-3">
                  {actions.map((action) => (
                    <Button
                      key={action.request}
                      size="md"
                      variant={action.request === "solution" ? "secondary" : "tertiary"}
                      onClick={() => void send({ action: "help", reviewId: response.reviewId, request: action.request, requestKey: newRequestKey() })}
                    >
                      {action.label}
                    </Button>
                  ))}
                </div>
                <p className="text-small text-neutral-500">
                  More help is recorded, so a later submission of this task counts as assisted practice. Corrections show how to fix it.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function ReviewResult({
  response,
  lines,
  flagged,
  focused,
  language,
  criterionText,
  lessonId,
  onFocusFinding,
  onSeek,
}: {
  response: ReviewResponse;
  lines: string[];
  flagged: ReadonlySet<number>;
  focused: PresentedFinding | null;
  language: string;
  criterionText: ReadonlyMap<string, string>;
  lessonId: string;
  onFocusFinding: (id: string) => void;
  onSeek: (seconds: number) => boolean;
}) {
  const { title, detail } = outcomeText(response, language);
  const note = evidenceNote(response);
  const codeRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    if (!focused) return;
    const line = codeRef.current?.querySelector<HTMLElement>(`[data-line="${focused.lines.start}"]`);
    line?.scrollIntoView({ block: "nearest" });
  }, [focused]);

  return (
    <article className="flex flex-col gap-4 rounded-md border border-neutral-200 px-4 py-4">
      <div>
        <p className="text-small tracking-wider text-neutral-500 uppercase">
          Review{response.help.level > 0 ? ` · ${response.help.level >= 3 ? "with corrections" : response.help.level === 2 ? "explained" : "hints"}` : ""}
        </p>
        <h3 className="mt-1 font-display text-h3 text-neutral-900">{title}</h3>
        <p className="mt-1 text-body text-neutral-700">{detail}</p>
        {note && <p className="mt-1 text-small text-neutral-500">{note}</p>}
      </div>

      {response.outcome !== "cannot_judge" && (
        <div className="overflow-x-auto rounded-md border border-neutral-200 bg-canvas">
          <ol ref={codeRef} aria-label="Your reviewed code" className="min-w-fit py-2 font-mono text-small">
            {lines.map((text, index) => {
              const number = index + 1;
              const inFocus = focused !== null && number >= focused.lines.start && number <= focused.lines.end;
              return (
                <li
                  key={number}
                  data-line={number}
                  className={cn(
                    "flex gap-4 px-3 whitespace-pre",
                    flagged.has(number) && "bg-primary-100",
                    inFocus && "bg-primary-200",
                  )}
                >
                  <span aria-hidden className="w-8 shrink-0 text-right text-neutral-500 select-none">
                    {number}
                  </span>
                  <span className="text-neutral-900">{text || " "}</span>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {response.findings.length > 0 && (
        <ul className="flex flex-col gap-4">
          {response.findings.map((finding) => {
            const criterion = finding.criterionId ? criterionText.get(finding.criterionId) : undefined;
            return (
              <li key={finding.id} className="flex flex-col gap-2 border-t border-neutral-200 pt-4 first:border-t-0 first:pt-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={finding.category === "alternative_valid" ? "video" : "lesson"}>{CATEGORY[finding.category]}</Badge>
                  <button
                    type="button"
                    onClick={() => onFocusFinding(finding.id)}
                    className="rounded-md text-small text-primary-500 underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:outline-none"
                  >
                    {`Show ${lineRangeText(finding.lines.start, finding.lines.end)}`}
                  </button>
                </div>
                {criterion && <p className="text-small text-neutral-500">Criterion: {criterion}</p>}
                {finding.question && <p className="text-body-lg text-neutral-900">{finding.question}</p>}
                {finding.explanation && <p className="text-body text-neutral-700">{finding.explanation}</p>}
                {finding.correction && (
                  <div className="rounded-md border border-neutral-200 bg-canvas px-3 py-2">
                    <p className="text-small tracking-wider text-neutral-500 uppercase">Correction</p>
                    <p className="mt-1 font-mono text-small whitespace-pre-wrap text-neutral-900">{finding.correction}</p>
                  </div>
                )}
                {finding.concepts.length > 0 && (
                  <p className="text-small text-neutral-500">Concepts: {finding.concepts.map((concept) => concept.name).join(", ")}</p>
                )}
                {finding.citations.length > 0 && (
                  <span className="flex flex-wrap gap-2">
                    {groupCitations(finding.citations).map((group) => {
                      const here = group.lessonId === lessonId;
                      const text = citationText(group, lessonId);
                      return (
                        <Link
                          key={group.chunkIds.join(" ")}
                          href={group.href}
                          onClick={(event) => {
                            if (here && onSeek(group.startSeconds)) event.preventDefault();
                          }}
                          aria-label={here ? `Play the video from ${text}` : `Open ${text}`}
                          className="inline-flex items-center gap-1.5 rounded-full border border-neutral-200 px-3 py-1 text-small text-neutral-700 transition-colors hover:border-primary-400 hover:text-primary-500 focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:outline-none"
                        >
                          <Icon name={here ? "play-solid" : "arrow-right"} size={12} />
                          {text}
                        </Link>
                      );
                    })}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-small text-neutral-500">
        This review is a model&apos;s reading of your code against the criteria. Nothing was run, and it can be wrong. A different
        approach from the lesson is fine when it meets the criteria.
      </p>
    </article>
  );
}
