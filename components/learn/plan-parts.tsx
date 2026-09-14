import { Badge, Icon, type BadgeVariant, type IconName } from "@/components/ui";
import { cn } from "@/lib/cn";
import { formatClock, formatDuration } from "@/lib/format";
import type { PlanItemResponse } from "@/lib/learner/next-action-contracts";
import type { ActionKind, NoticeCode } from "@/lib/next-action";

/** Shared pieces of a next-action item, on `/learn` and on My Learning. */

const KIND: Record<ActionKind, { label: string; badge: BadgeVariant; icon: IconName }> = {
  practise: { label: "Practice", badge: "practice", icon: "refresh" },
  continue: { label: "Continue", badge: "video", icon: "play-solid" },
  learn: { label: "Learn", badge: "lesson", icon: "bulb" },
  diagnose: { label: "Check", badge: "developing", icon: "target" },
  next_lesson: { label: "Next in course", badge: "neutral", icon: "document" },
};

export function kindIcon(item: PlanItemResponse): IconName {
  return KIND[item.kind].icon;
}

export function KindBadge({ item }: { item: PlanItemResponse }) {
  const kind = KIND[item.kind];
  return <Badge variant={kind.badge}>{item.reasonCode === "weak_evidence_revisit" ? "Revisit" : kind.label}</Badge>;
}

/** Where the item leads, from stored data only: the lesson, the source moment or span, and the lesson's length. */
export function PlanMeta({ item, className }: { item: PlanItemResponse; className?: string }) {
  const parts: Array<{ icon: IconName; text: string }> = [];
  if (item.lesson) {
    const prefix = item.kind === "practise" ? "Taught in lesson" : "Lesson";
    parts.push({ icon: "play", text: `${prefix} ${item.lesson.number}: ${item.lesson.title}` });
  }
  if (item.span && item.kind !== "continue") {
    parts.push({
      icon: "clock",
      text:
        item.span.endSeconds !== null
          ? `${formatClock(item.span.startSeconds)}–${formatClock(item.span.endSeconds)}`
          : `From ${formatClock(item.span.startSeconds)}`,
    });
  } else if (item.lesson?.durationSeconds && (item.kind === "continue" || item.kind === "next_lesson")) {
    parts.push({ icon: "clock", text: `${formatDuration(item.lesson.durationSeconds)} lesson` });
  }
  if (parts.length === 0) return null;
  return (
    <ul className={cn("flex flex-wrap items-center gap-x-5 gap-y-2 text-small text-neutral-500", className)}>
      {parts.map((part) => (
        <li key={part.text} className="inline-flex min-w-0 items-center gap-1.5">
          <Icon name={part.icon} size={14} className="shrink-0" />
          <span className="min-w-0 truncate">{part.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** Honest statements about what the plan could and couldn't use. */
export const NOTICE_TEXT: Record<NoticeCode, string> = {
  no_reviewed_concepts: "This course has no reviewed concepts yet, so the plan follows course order.",
  no_prerequisite_edges:
    "No prerequisites between this course’s concepts have been reviewed yet, so the plan can’t check what you’re ready for.",
  prerequisite_graph_defects: "Some prerequisite links couldn’t be verified, so they weren’t used.",
  no_evidence_no_check:
    "You haven’t answered any questions in this course yet, and no check is available, so this plan follows course order rather than your answers.",
  no_eligible_concept: "Your answers so far don’t point to a concept to work on next in this course.",
  course_complete: "You’ve finished every lesson in this course. Choose another goal, or browse courses.",
};

export function PlanNotices({ notices, className }: { notices: readonly NoticeCode[]; className?: string }) {
  if (notices.length === 0) return null;
  return (
    <ul className={cn("flex flex-col gap-2", className)}>
      {notices.map((notice) => (
        <li key={notice} className="flex items-start gap-2 text-body text-neutral-500">
          <Icon name="info" size={16} className="mt-0.5 shrink-0" />
          <span>{NOTICE_TEXT[notice]}</span>
        </li>
      ))}
    </ul>
  );
}
