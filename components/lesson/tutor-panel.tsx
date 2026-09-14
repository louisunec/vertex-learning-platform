"use client";

import { useId, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import posthog from "posthog-js";
import { Badge, Button, Icon, Status } from "@/components/ui";
import { cn } from "@/lib/cn";
import { citationText, groupCitations, type CitationKind } from "@/lib/lesson/citations";
import { newRequestKey, postLearnerJson } from "@/lib/lesson/api";
import type { TutorUnavailableReason } from "@/lib/lesson/features";
import { formatClock } from "@/lib/format";
import { tutorHelpActions, type HelpActionRequest } from "@/lib/lesson/help-actions";
import type { TutorResponse } from "@/lib/learner/contracts";
import { Drawer } from "./drawer";
import { useActiveTask, useLessonPlayer } from "./lesson-player";

/**
 * Where the tutor sits: an always-open right column beside the video on wide
 * screens, or a trigger card that opens a bottom drawer on narrower ones. The
 * lesson workspace decides, from one breakpoint, for the whole page.
 */
export type TutorLayout = "column" | "drawer";

type Mode = "study" | "reference";

/** One `/api/tutor` call; a retry resends it unchanged, so the server cannot record it twice. */
type TutorCall = {
  question: string;
  currentSeconds: number;
  mode: Mode;
  helpRequest: HelpActionRequest | null;
  taskInstanceId: string | null;
  requestKey: string;
};

type Turn = { call: TutorCall; response: TutorResponse };
type Failure = { call: TutorCall; code: string; retryable: boolean };

const TITLE = "Ask about this lesson";
const SUBTITLE = "Get help at the moment you're watching.";
const MAX_QUESTION = 500;
const MIN_QUESTION = 3;

const SCOPE_TEXT: Record<TutorResponse["scope"], string> = {
  window: "near this point in the video",
  lesson: "across this lesson",
  course: "across this course",
};

/** What the learner asked for on a follow-up turn, in the words of the button they pressed. */
const HELP_REQUEST_TEXT: Record<HelpActionRequest, string> = {
  hint: "A hint",
  escalate: "Another hint",
  solution: "The explanation",
};

const CITATION_KIND_TEXT: Record<CitationKind, string> = {
  transcript: "Transcript",
  visual: "Visual",
};

const UNAVAILABLE_TEXT: Record<TutorUnavailableReason, string> = {
  rollout: "The lesson tutor isn't switched on for your account yet.",
  provider: "The tutor needs a video it can follow, so it isn't available for this lesson.",
};

function failureText(code: string): string {
  switch (code) {
    case "rate_limited":
      return "You've reached this hour's limit of tutor questions. Try again later.";
    case "already_answered":
      return "That answer was recorded but didn't reach this page. Ask again to get a new one.";
    case "invalid_request":
      return "The tutor couldn't take that question. Try rephrasing it.";
    case "not_found":
      return "The tutor isn't available for this lesson.";
    case "unauthenticated":
      return "Your session has ended. Sign in again to ask the tutor.";
    case "network":
    case "unavailable":
      return "The tutor is unavailable right now. Nothing was recorded, so you can try again.";
    default:
      return "Something went wrong. Please try again later.";
  }
}

/**
 * The tutor's heading block, shared by the column card, the drawer trigger,
 * and the unavailable state. With `titleId` the title is a real heading;
 * without it (inside the trigger button) it stays phrasing content.
 */
function TutorHeading({ titleId, detail }: { titleId?: string; detail: ReactNode }) {
  const Title = titleId ? "h2" : "span";
  const Wrap = titleId ? "div" : "span";
  return (
    <Wrap className="flex items-start gap-3">
      <Icon name="message" size={22} className="mt-0.5 shrink-0 text-primary-500" />
      <Wrap>
        <Title id={titleId} className="block font-display text-h3 text-neutral-900">
          {TITLE}
        </Title>
        <span className="mt-0.5 block text-body text-neutral-500">{detail}</span>
      </Wrap>
    </Wrap>
  );
}

/**
 * The tutor while its gate is not met: the same place and heading, with the
 * reason and nothing to type into — no sample conversation, no suggested
 * questions.
 */
export function TutorUnavailable({ reason, layout }: { reason: TutorUnavailableReason; layout: TutorLayout }) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      className={cn("rounded-[20px] border border-neutral-200 bg-surface", layout === "column" ? "px-6 py-5" : "px-5 py-4")}
    >
      <TutorHeading titleId={titleId} detail="Not available yet" />
      <p className="mt-4 text-body text-neutral-700">{UNAVAILABLE_TEXT[reason]}</p>
    </section>
  );
}

/**
 * The lesson-page tutor (development plan §5 PR-7) over `/api/tutor` (PR-6).
 * Questions go out with the real playhead, a per-page-load session id, and
 * the open check question's task instance (from `LessonPlayerProvider`). The
 * server decides the help level; "Another hint" and "Show the explanation"
 * only ask for more. Each turn repeats the learner's own question and the
 * video second it was asked at. Citation buttons say whether they point at
 * the transcript or at validated on-screen evidence, seek the provider player
 * in place for this lesson, and link (keeping `?t=`) to other lessons. The
 * workspace renders one instance and only changes its `layout`, so the
 * conversation survives a resize. No question or answer text is sent to
 * analytics or captured in replays.
 */
export function TutorPanel({
  lessonId,
  lessonSlug,
  courseSlug,
  startSeconds,
  durationSeconds,
  layout,
}: {
  lessonId: string;
  lessonSlug: string;
  courseSlug: string | null;
  startSeconds: number | null;
  durationSeconds: number | null;
  layout: TutorLayout;
}) {
  const player = useLessonPlayer();
  const activeTask = useActiveTask();
  const [open, setOpen] = useState(false);
  const [sessionId] = useState(newRequestKey);
  const [question, setQuestion] = useState("");
  const [mode, setMode] = useState<Mode>("study");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, setPending] = useState<TutorCall | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const titleId = useId();
  const questionId = useId();

  async function send(call: TutorCall) {
    setPending(call);
    setFailure(null);
    const result = await postLearnerJson<TutorResponse>("/api/tutor", {
      lessonId,
      currentSeconds: call.currentSeconds,
      question: call.question,
      mode: call.mode,
      ...(call.helpRequest ? { helpRequest: call.helpRequest } : {}),
      sessionId,
      ...(call.taskInstanceId ? { taskInstanceId: call.taskInstanceId } : {}),
      requestKey: call.requestKey,
    });
    setPending(null);

    posthog.capture("tutor_asked", {
      lesson_slug: lessonSlug,
      course_slug: courseSlug,
      mode: call.mode,
      help_request: call.helpRequest ?? "ask",
      has_task: call.taskInstanceId !== null,
      status: result.ok ? result.data.status : null,
      error_code: result.ok ? null : result.code,
      scope: result.ok ? result.data.scope : null,
      help_level: result.ok ? (result.data.help?.level ?? null) : null,
    });
    if (!result.ok) {
      setFailure({ call, code: result.code, retryable: result.retryable });
      return;
    }
    if (call.helpRequest) {
      posthog.capture("hint_escalated", {
        source: "tutor",
        lesson_slug: lessonSlug,
        request: call.helpRequest,
        level: result.data.help?.level ?? null,
      });
    }
    const turn = { call, response: result.data };
    setTurns((previous) => (call.helpRequest ? [...previous, turn] : [turn]));
    setQuestion((current) => (call.helpRequest ? current : ""));
  }

  function ask(event: FormEvent) {
    event.preventDefault();
    const text = question.trim();
    if (text.length < MIN_QUESTION || pending) return;
    // The route rejects a playhead past the stored duration; the live player can report a little more.
    const position = Math.floor(player?.getPosition() ?? startSeconds ?? 0);
    void send({
      question: text,
      currentSeconds: durationSeconds ? Math.min(position, durationSeconds) : position,
      mode,
      helpRequest: null,
      taskInstanceId: activeTask?.taskInstanceId ?? null,
      requestKey: newRequestKey(),
    });
  }

  const last = turns.at(-1);
  const answered = last && (last.response.status === "supported" || last.response.status === "partial");
  const actions = answered ? tutorHelpActions(last.response.help?.level ?? 0) : [];

  const conversation = (
    <div aria-live="polite" aria-busy={pending !== null} className="flex flex-col gap-5">
      {turns.map((turn) => (
        <div key={turn.response.tutorRequestId} className="flex flex-col gap-3">
          <LearnerTurn call={turn.call} />
          <TutorAnswer
            response={turn.response}
            lessonId={lessonId}
            onSeek={(seconds) => {
              if (!player) return false;
              if (layout === "drawer") setOpen(false);
              return player.seekTo(seconds);
            }}
          />
        </div>
      ))}

      {pending && (
        <div className="flex flex-col gap-3">
          <LearnerTurn call={pending} />
          <Status kind="in-progress" label="Looking through the course…" />
        </div>
      )}

      {failure && !pending && (
        <div className="flex flex-col items-start gap-3 rounded-md border border-neutral-200 px-4 py-3">
          <p className="text-body text-neutral-900">{failureText(failure.code)}</p>
          {failure.code === "already_answered" ? (
            <Button size="md" variant="tertiary" onClick={() => void send({ ...failure.call, requestKey: newRequestKey() })}>
              Ask again
            </Button>
          ) : failure.retryable && failure.code !== "rate_limited" ? (
            <Button size="md" variant="tertiary" onClick={() => void send(failure.call)}>
              Try again
            </Button>
          ) : null}
        </div>
      )}

      {last && actions.length > 0 && !pending && (
        <div className="flex flex-wrap gap-3">
          {actions.map((action) => (
            <Button
              key={action.request}
              size="md"
              variant={action.request === "solution" ? "secondary" : "tertiary"}
              onClick={() => void send({ ...last.call, helpRequest: action.request, requestKey: newRequestKey() })}
            >
              {action.label}
            </Button>
          ))}
        </div>
      )}

      {answered && (
        <p className="text-small text-neutral-500">
          Each answer was checked automatically against the clips it cites. That check can miss mistakes.
        </p>
      )}
    </div>
  );

  const form = (
    <form onSubmit={ask} className="flex flex-col gap-4">
      {activeTask && (
        <p className="rounded-md border border-neutral-200 px-3 py-2 text-small text-neutral-700">
          You have {activeTask.label} open. Help from the tutor counts as help on that question.
        </p>
      )}

      <div>
        <label htmlFor={questionId} className="text-body font-medium text-neutral-900">
          Your question
        </label>
        <textarea
          id={questionId}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          maxLength={MAX_QUESTION}
          rows={3}
          required
          placeholder="What does this part of the video mean?"
          className="mt-2 w-full resize-y rounded-md border border-neutral-200 bg-canvas px-4 py-3 text-body-lg text-neutral-900 transition-colors placeholder:text-neutral-500 focus:border-primary-400 focus:outline-none"
        />
        <p className="mt-1 text-small text-neutral-500">
          The tutor looks near where you are in the video first. Answers cite the course moments they come from.
        </p>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-body font-medium text-neutral-900">How should it help?</legend>
        {(
          [
            ["study", "Guide me", "Hints first; ask for more when you want it."],
            ["reference", "Just explain it", "The full explanation straight away."],
          ] as const
        ).map(([value, label, hint]) => (
          <label key={value} className="flex cursor-pointer items-start gap-3 text-body text-neutral-700">
            <input
              type="radio"
              name={`${questionId}-mode`}
              value={value}
              checked={mode === value}
              onChange={() => setMode(value)}
              className="mt-0.5 accent-primary-500"
            />
            <span>
              <span className="text-neutral-900">{label}</span> — {hint}
            </span>
          </label>
        ))}
      </fieldset>

      <div>
        <Button type="submit" size="md" disabled={pending !== null || question.trim().length < MIN_QUESTION}>
          Ask
        </Button>
      </div>
    </form>
  );

  const body = (
    <div className="flex flex-col gap-6">
      {conversation}
      {form}
    </div>
  );

  if (layout === "column") {
    return (
      <section
        aria-labelledby={titleId}
        className="ph-no-capture flex max-h-full min-h-0 flex-col rounded-[20px] border border-neutral-200 bg-surface"
      >
        <div className="border-b border-neutral-200 px-6 py-5">
          <TutorHeading titleId={titleId} detail={SUBTITLE} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-5 pb-6">{body}</div>
      </section>
    );
  }

  return (
    <section className="ph-no-capture rounded-[20px] border border-neutral-200 bg-surface">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="flex w-full items-center justify-between gap-4 rounded-[20px] px-5 py-4 text-left focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:outline-none"
      >
        <TutorHeading detail={SUBTITLE} />
        <Icon name="chevron-right" size={20} className="shrink-0 text-neutral-500" />
      </button>
      <Drawer open={open} onClose={() => setOpen(false)} title={TITLE}>
        {body}
      </Drawer>
    </section>
  );
}

/** The learner's side of a turn: their own words and the video second they were asked at. */
function LearnerTurn({ call }: { call: TutorCall }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-small text-neutral-500">
        You · at {formatClock(call.currentSeconds)}
      </p>
      <p className="rounded-md bg-neutral-50 px-4 py-3 text-body text-neutral-900">
        {call.helpRequest ? HELP_REQUEST_TEXT[call.helpRequest] : call.question}
      </p>
    </div>
  );
}

function TutorAnswer({
  response,
  lessonId,
  onSeek,
}: {
  response: TutorResponse;
  lessonId: string;
  onSeek: (seconds: number) => boolean;
}) {
  if (response.status === "insufficient_evidence") {
    return (
      <div className="rounded-md border border-neutral-200 px-4 py-3 text-body text-neutral-700">
        <p>{response.message}</p>
        <p className="mt-1 text-small text-neutral-500">Searched {SCOPE_TEXT[response.scope]}.</p>
      </div>
    );
  }
  if (response.status === "clarification_needed") {
    return <p className="rounded-md border border-neutral-200 px-4 py-3 text-body text-neutral-900">{response.followUp}</p>;
  }

  const level = response.help?.level ?? 0;
  return (
    <article className="flex flex-col gap-3 rounded-md border border-neutral-200 px-4 py-4">
      <p className="text-small tracking-wider text-neutral-500 uppercase">
        {level >= 3 ? "Explanation" : "Hint"} ·{" "}
        {response.status === "supported" ? "From the course" : "Partly supported by the course"}
      </p>
      <ul className="flex flex-col gap-3">
        {response.statements.map((statement, index) => (
          <li key={index} className="text-body-lg text-neutral-900">
            {statement.kind === "analogy" && (
              <Badge variant="lesson" className="mr-2 align-middle">
                Analogy
              </Badge>
            )}
            {statement.text}
            {statement.citations.length > 0 && (
              <span className="mt-2 flex flex-wrap gap-2">
                {groupCitations(statement.citations).map((group) => {
                  const here = group.lessonId === lessonId;
                  const text = citationText(group, lessonId);
                  const kind = CITATION_KIND_TEXT[group.kind];
                  return (
                    <Link
                      key={group.chunkIds.join(" ")}
                      href={group.href}
                      onClick={(event) => {
                        if (here && onSeek(group.startSeconds)) event.preventDefault();
                      }}
                      aria-label={here ? `Play the video from ${text} (${kind.toLowerCase()})` : `Open ${text} (${kind.toLowerCase()})`}
                      className="inline-flex items-center gap-2 rounded-full border border-neutral-200 py-1 pr-3 pl-1.5 text-small text-neutral-700 transition-colors hover:border-primary-400 hover:text-primary-500 focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:outline-none"
                    >
                      <Badge variant={group.kind === "visual" ? "lesson" : "video"} className="rounded-full">
                        {kind}
                      </Badge>
                      <Icon name={here ? "play-solid" : "arrow-right"} size={12} />
                      {text}
                    </Link>
                  );
                })}
              </span>
            )}
          </li>
        ))}
      </ul>
      {response.followUp && <p className="text-body text-neutral-700 italic">{response.followUp}</p>}
    </article>
  );
}
