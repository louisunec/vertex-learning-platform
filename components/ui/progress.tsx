import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

/** 11 · Progress Bar */
export interface ProgressBarProps extends HTMLAttributes<HTMLDivElement> {
  /** 0–100 */
  value: number;
  /** Show "{value}% complete" to the right of the track. */
  showLabel?: boolean;
}

export function ProgressBar({ value, showLabel = true, className, ...props }: ProgressBarProps) {
  const clamped = Math.min(100, Math.max(0, Math.round(value)));
  return (
    <div className={cn("flex items-center gap-4", className)} {...props}>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={clamped}
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-primary-100"
      >
        <div className="h-full rounded-full bg-primary-500 transition-[width]" style={{ width: `${clamped}%` }} />
      </div>
      {showLabel && <span className="shrink-0 text-body text-neutral-900">{clamped}% complete</span>}
    </div>
  );
}
