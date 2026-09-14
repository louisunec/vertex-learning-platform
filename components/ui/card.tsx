import type { HTMLAttributes, MouseEventHandler, ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";
import { Badge, type BadgeVariant } from "./badge";
import { Icon, type IconName } from "./icon";

/** 12 · Cards */
export function Card({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-lg border border-neutral-200 bg-white p-5 shadow-sm", className)}
      {...props}
    >
      {children}
    </div>
  );
}

/* ---------- Course Card ---------- */
export interface CourseCardProps {
  title: string;
  description: string;
  /** Logo / icon tile — rendered at 40×40 in `row` layout, in a 192×108 (16:9) frame in `stacked`. */
  icon: ReactNode;
  level: string;
  /** Omitted when the stored value is missing — never render a placeholder. */
  duration?: string;
  modules?: string;
  /** When set, the title becomes a link that stretches over the whole card. */
  href?: string;
  /** Called when the linked course card is selected. */
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  /**
   * `row` (default) is the compact design-system card.
   * `stacked` is the catalog card: large tile on top, serif title, divider + meta row at the bottom.
   */
  layout?: "row" | "stacked";
  className?: string;
}

export function CourseCard({
  title,
  description,
  icon,
  level,
  duration,
  modules,
  href,
  onClick,
  layout = "row",
  className,
}: CourseCardProps) {
  const meta: Array<{ icon: IconName; label: string }> = [{ icon: "chart", label: level }];
  if (duration) meta.push({ icon: "clock", label: duration });
  if (modules) meta.push({ icon: "folder", label: modules });

  const heading = href ? (
    <Link href={href} onClick={onClick} className="after:absolute after:inset-0 after:rounded-lg">
      {title}
    </Link>
  ) : (
    title
  );

  if (layout === "stacked") {
    return (
      <Card className={cn("relative flex flex-col p-6", href && "transition-colors hover:border-neutral-300", className)}>
        <div className="flex aspect-video w-48 max-w-full shrink-0 items-center justify-center overflow-hidden rounded-lg">{icon}</div>
        <h3 className="mt-9 font-display text-[22px] leading-7 font-normal text-neutral-900">{heading}</h3>
        <p className="mt-4 text-body leading-6 text-neutral-500">{description}</p>
        <div aria-hidden="true" className="min-h-12 flex-1" />
        <CourseMeta items={meta} iconSize={14} className="justify-between gap-x-4 gap-y-2 border-t border-neutral-200 pt-5" />
      </Card>
    );
  }

  return (
    <Card className={cn("relative flex flex-col gap-4", className)}>
      <div className="flex gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-sm">{icon}</div>
        <div className="flex flex-col gap-1">
          <h3 className="text-body font-semibold text-neutral-900">{heading}</h3>
          <p className="text-small leading-5 text-neutral-500">{description}</p>
        </div>
      </div>
      <CourseMeta items={meta} iconSize={16} className="gap-4" />
    </Card>
  );
}

function CourseMeta({
  items,
  iconSize,
  className,
}: {
  items: Array<{ icon: IconName; label: string }>;
  iconSize: number;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center text-small text-neutral-700", className)}>
      {items.map((m) => (
        <span key={m.icon} className="inline-flex items-center gap-1.5">
          <Icon name={m.icon} size={iconSize} />
          {m.label}
        </span>
      ))}
    </div>
  );
}

/* ---------- Lesson Card ---------- */
export interface LessonCardProps {
  badge: BadgeVariant;
  title: string;
  description: string;
  /** Left-hand metadata, e.g. ["Lesson 5.1", "12:45"]. */
  meta: string[];
  /** Right-hand action. */
  action: ReactNode;
  className?: string;
}

export function LessonCard({ badge, title, description, meta, action, className }: LessonCardProps) {
  return (
    <Card className={cn("flex flex-col gap-3", className)}>
      <Badge variant={badge}>{badge}</Badge>
      <div className="flex flex-col gap-1.5">
        <h3 className="text-body-lg font-semibold text-neutral-900">{title}</h3>
        <p className="text-small leading-5 text-neutral-500">{description}</p>
      </div>
      <div className="mt-auto flex items-center justify-between gap-4 pt-1">
        <MetaRow items={meta} />
        {action}
      </div>
    </Card>
  );
}

/* ---------- Resource Card ---------- */
export interface ResourceCardProps {
  title: string;
  description: string;
  /** e.g. ["PDF", "1.2 MB"] */
  meta: string[];
  href?: string;
  className?: string;
}

export function ResourceCard({ title, description, meta, href = "#", className }: ResourceCardProps) {
  return (
    <Card className={cn("flex flex-col gap-4", className)}>
      <div className="flex gap-3">
        <Icon name="document" size={28} className="mt-0.5 shrink-0 text-neutral-900" />
        <div className="flex flex-col gap-1">
          <h3 className="text-body font-semibold text-neutral-900">{title}</h3>
          <p className="text-small leading-5 text-neutral-500">{description}</p>
        </div>
      </div>
      <div className="mt-auto flex items-center justify-between">
        <MetaRow items={meta} />
        <a href={href} aria-label={`Open ${title}`} className="text-primary-500 hover:text-primary-600">
          <Icon name="external-link" size={18} />
        </a>
      </div>
    </Card>
  );
}

function MetaRow({ items }: { items: string[] }) {
  return (
    <span className="flex shrink-0 items-center gap-2 text-small whitespace-nowrap text-neutral-700">
      {items.map((item, i) => (
        <span key={item} className="flex items-center gap-2">
          {i > 0 && <span aria-hidden="true" className="text-neutral-300">·</span>}
          {item}
        </span>
      ))}
    </span>
  );
}
