import { Button, Card, Icon, type IconName } from "@/components/ui";
import { formatClock } from "@/lib/format";
import type { NextStep } from "@/lib/my-learning";
import { Eyebrow, IconTile } from "./card-parts";

type Course = { title: string };

type Content = { icon: IconName; eyebrow: string; title: string; detail: string; action: string; href: string };

function content(step: NextStep<Course>): Content {
  const browse = { action: "Browse courses", href: "/courses" };
  switch (step.kind) {
    case "continue":
      return {
        icon: "play-solid",
        eyebrow: "Continue learning",
        title: step.lesson.title,
        detail: step.resumeSeconds
          ? `${step.course.title} · Resume at ${formatClock(step.resumeSeconds)}`
          : step.course.title,
        action: "Continue lesson",
        href: `/lessons/${step.lesson.slug}`,
      };
    case "start":
      return {
        icon: "play-solid",
        eyebrow: "Get started",
        title: "Start your first course",
        detail: "Pick a course to begin. Your progress will appear here as you watch.",
        ...browse,
      };
    case "course_complete":
      return {
        icon: "check-circle",
        eyebrow: "Course complete",
        title: `You finished ${step.course.title}`,
        detail: "Choose what to learn next.",
        ...browse,
      };
    case "missing_content":
      return {
        icon: "document",
        eyebrow: "Continue learning",
        title: "Your saved lessons are no longer available",
        detail: "They may have been unpublished. Choose another course to continue.",
        ...browse,
      };
    case "error":
      return {
        icon: "refresh",
        eyebrow: "Continue learning",
        title: "We couldn’t load your progress",
        detail: "Refresh to try again. You can still browse courses.",
        ...browse,
      };
  }
}

/** The overview's single primary action: resume real progress, or browse courses. */
export function NextStepCard({ step }: { step: NextStep<Course> }) {
  const { icon, eyebrow, title, detail, action, href } = content(step);
  return (
    <Card className="flex flex-col gap-6 p-6 md:flex-row md:items-center md:p-8">
      <IconTile icon={icon} tone={step.kind === "error" ? "neutral" : "primary"} size="lg" />
      <div className="min-w-0 flex-1">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h2 className="mt-2 text-[24px] leading-8 font-semibold text-neutral-900">{title}</h2>
        <p className="mt-1 text-[15px] leading-[21px] text-neutral-500">{detail}</p>
      </div>
      <Button href={href} iconRight={<Icon name="arrow-right" size={18} />} className="self-start md:self-center">
        {action}
      </Button>
    </Card>
  );
}
