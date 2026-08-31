import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

/** 09 · Badges / Tags */
export type BadgeVariant = "video" | "lesson" | "popular";

const variants: Record<BadgeVariant, string> = {
  video: "bg-primary-100 text-primary-500",
  lesson: "bg-lesson-bg text-lesson",
  popular: "bg-primary-200 text-primary-600",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

export function Badge({ variant = "video", className, children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex h-5 w-fit items-center rounded-xs px-2 text-[11px] font-semibold tracking-wider uppercase",
        variants[variant],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}
