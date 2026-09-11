import type { InputHTMLAttributes, SelectHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { Icon } from "./icon";

/**
 * 08 · Inputs — height 44px, radius 12px, 1px neutral-200 border,
 * 0 16px padding, primary-400 border on focus.
 */
const fieldBase =
  "h-11 w-full rounded-md border border-neutral-200 bg-surface text-body text-neutral-900 transition-colors " +
  "placeholder:text-neutral-500 focus:border-primary-400 focus:outline-none disabled:bg-neutral-50 disabled:text-neutral-300";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Show a leading search icon. */
  search?: boolean;
  /** Keyboard shortcut hint rendered at the trailing edge, e.g. "⌘ K". */
  shortcut?: string;
}

export function Input({ search, shortcut, className, ...props }: InputProps) {
  return (
    <div className={cn("relative", className)}>
      {search && (
        <Icon
          name="search"
          size={20}
          className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-neutral-900"
        />
      )}
      <input
        className={cn(fieldBase, search ? "pl-11" : "pl-4", shortcut ? "pr-14" : "pr-4")}
        {...props}
      />
      {shortcut && (
        <kbd className="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 font-sans text-body text-neutral-900">
          {shortcut}
        </kbd>
      )}
    </div>
  );
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options: Array<{ value: string; label: string }>;
}

export function Select({ options, className, ...props }: SelectProps) {
  return (
    <div className={cn("relative", className)}>
      <select className={cn(fieldBase, "appearance-none pr-11 pl-4 font-medium")} {...props}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Icon
        name="chevron-down"
        size={20}
        className="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-neutral-900"
      />
    </div>
  );
}
