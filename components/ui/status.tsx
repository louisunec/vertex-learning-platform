import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { Icon, type IconName } from "./icon";

/** 10 · Status / Indicators */
export type StatusKind = "in-progress" | "completed" | "now-playing" | "locked";

const config: Record<
  StatusKind,
  { label: string; icon: IconName; filled?: boolean; color: string; spin?: boolean }
> = {
  "in-progress": { label: "In Progress", icon: "loader", color: "text-primary-500", spin: true },
  completed: { label: "Completed", icon: "check-circle", color: "text-success" },
  "now-playing": { label: "Now Playing", icon: "play", filled: true, color: "text-primary-500" },
  locked: { label: "Locked", icon: "lock", color: "text-neutral-500" },
};

export interface StatusProps extends HTMLAttributes<HTMLSpanElement> {
  kind: StatusKind;
  /** Override the default label. */
  label?: string;
}

export function Status({ kind, label, className, ...props }: StatusProps) {
  const c = config[kind];
  return (
    <span className={cn("inline-flex items-center gap-2 text-body text-neutral-900", className)} {...props}>
      <Icon
        name={c.icon}
        filled={c.filled}
        size={18}
        className={cn(c.color, c.spin && "animate-spin [animation-duration:1.6s]")}
      />
      {label ?? c.label}
    </span>
  );
}
