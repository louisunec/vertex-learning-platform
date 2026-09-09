import type { HTMLAttributes } from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";
import { Icon } from "./icon";
import { Logo } from "./logo";

/** 13 · Navigation */

/* ---------- Navbar ---------- */
export interface NavItem {
  label: string;
  href: string;
  active?: boolean;
}

export interface NavbarProps extends HTMLAttributes<HTMLElement> {
  items: NavItem[];
}

export function Navbar({ items, className, ...props }: NavbarProps) {
  return (
    <nav className={cn("flex items-center gap-5 sm:gap-8", className)} aria-label="Primary" {...props}>
      <Link href="/" className="inline-flex">
        <Logo size={24} />
      </Link>
      <ul className="flex items-center gap-4 sm:gap-6">
        {items.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={item.active ? "page" : undefined}
              className={cn(
                "text-body font-medium whitespace-nowrap transition-colors hover:text-primary-500",
                item.active ? "text-primary-500" : "text-neutral-900",
              )}
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/* ---------- Breadcrumbs ---------- */
export interface Crumb {
  label: string;
  href?: string;
}

export function Breadcrumbs({ items, className }: { items: Crumb[]; className?: string }) {
  return (
    <nav aria-label="Breadcrumb" className={className}>
      <ol className="flex flex-wrap items-center gap-2 text-body text-neutral-500">
        {items.map((item, i) => {
          const last = i === items.length - 1;
          return (
            <li key={item.label} className="flex items-center gap-2">
              {i > 0 && <Icon name="chevron-right" size={14} className="text-neutral-300" />}
              {item.href && !last ? (
                <Link href={item.href} className="transition-colors hover:text-neutral-900">
                  {item.label}
                </Link>
              ) : (
                <span aria-current={last ? "page" : undefined} className={last ? "text-neutral-900" : undefined}>
                  {item.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/* ---------- Pagination ---------- */
export interface PaginationProps {
  page: number;
  totalPages: number;
  /** Build the href for a page number. */
  hrefFor?: (page: number) => string;
  className?: string;
}

function pageRange(page: number, total: number): Array<number | "…"> {
  if (total <= 5) return Array.from({ length: total }, (_, i) => i + 1);
  // Always show first, last and a window of three around the current page.
  const start = Math.min(Math.max(page - 1, 1), total - 2);
  const set = new Set<number>([1, total, start, start + 1, start + 2].filter((p) => p >= 1 && p <= total));
  const sorted = [...set].sort((a, b) => a - b);
  const out: Array<number | "…"> = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) out.push("…");
    out.push(p);
  });
  return out;
}

const cell = "inline-flex size-9 items-center justify-center rounded-sm text-body transition-colors";

export function Pagination({ page, totalPages, hrefFor = (p) => `?page=${p}`, className }: PaginationProps) {
  const prevDisabled = page <= 1;
  const nextDisabled = page >= totalPages;
  return (
    <nav aria-label="Pagination" className={cn("flex items-center gap-1", className)}>
      <PageArrow href={hrefFor(page - 1)} disabled={prevDisabled} label="Previous page" icon="chevron-left" />
      {pageRange(page, totalPages).map((p, i) =>
        p === "…" ? (
          <span key={`gap-${i}`} className={cn(cell, "text-neutral-500")} aria-hidden="true">
            …
          </span>
        ) : (
          <Link
            key={p}
            href={hrefFor(p)}
            aria-current={p === page ? "page" : undefined}
            className={cn(
              cell,
              p === page
                ? "border border-primary-500 bg-primary-100 font-medium text-primary-500"
                : "text-neutral-900 hover:bg-neutral-100",
            )}
          >
            {p}
          </Link>
        ),
      )}
      <PageArrow href={hrefFor(page + 1)} disabled={nextDisabled} label="Next page" icon="chevron-right" />
    </nav>
  );
}

function PageArrow({
  href,
  disabled,
  label,
  icon,
}: {
  href: string;
  disabled: boolean;
  label: string;
  icon: "chevron-left" | "chevron-right";
}) {
  if (disabled) {
    return (
      <span className={cn(cell, "text-neutral-300")} aria-disabled="true" aria-label={label}>
        <Icon name={icon} size={16} />
      </span>
    );
  }
  return (
    <Link href={href} aria-label={label} className={cn(cell, "text-neutral-900 hover:bg-neutral-100")}>
      <Icon name={icon} size={16} />
    </Link>
  );
}
