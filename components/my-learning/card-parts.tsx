import type { ReactNode } from "react";
import Link from "next/link";
import { Icon, type IconName } from "@/components/ui";
import { cn } from "@/lib/cn";

/** Shared pieces of the My Learning overview cards. */

export type TileTone = "primary" | "neutral";

const tones: Record<TileTone, string> = {
  primary: "bg-primary-100 text-primary-500",
  neutral: "bg-neutral-200/50 text-neutral-900",
};

const tileSizes = {
  sm: { box: "size-12", icon: 16 },
  lg: { box: "size-[72px]", icon: 28 },
} as const;

export function IconTile({
  icon,
  tone,
  size,
  children,
}: {
  icon?: IconName;
  tone: TileTone;
  size: keyof typeof tileSizes;
  /** Text shown instead of an icon, e.g. a two-letter monogram. */
  children?: ReactNode;
}) {
  const { box, icon: iconSize } = tileSizes[size];
  return (
    <div
      aria-hidden="true"
      className={cn("flex shrink-0 items-center justify-center rounded-md text-small font-medium", box, tones[tone])}
    >
      {icon ? <Icon name={icon} size={iconSize} /> : children}
    </div>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="text-small font-medium tracking-[0.14em] text-neutral-500 uppercase">{children}</p>;
}

export function SectionHeader({ id, title, href, linkLabel }: { id: string; title: string; href?: string; linkLabel?: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <h2 id={id} className="text-h2 text-neutral-900">
        {title}
      </h2>
      {href && linkLabel && (
        <Link
          href={href}
          className="inline-flex items-center gap-1.5 text-body font-medium text-primary-500 hover:text-primary-600"
        >
          {linkLabel}
          <Icon name="arrow-right" size={14} />
        </Link>
      )}
    </div>
  );
}

/** A read that failed: said plainly, never shown as "nothing here". */
export function LoadError({ children }: { children: ReactNode }) {
  return (
    <p className="mt-6 flex items-start gap-2 rounded-md border border-neutral-200 px-4 py-3 text-body text-neutral-700">
      <Icon name="refresh" size={16} className="mt-0.5 text-neutral-500" />
      <span>{children}</span>
    </p>
  );
}
