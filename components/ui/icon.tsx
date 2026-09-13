import type { SVGProps } from "react";
import { cn } from "@/lib/cn";

/**
 * 06 · Icons — 24×24 grid, 2px stroke, rounded caps (outline) with a
 * matching filled variant for the core set.
 */
export type IconName =
  | "bell"
  | "search"
  | "play"
  | "file"
  | "bookmark"
  | "chart"
  | "clock"
  | "user"
  | "chevron-right"
  | "chevron-left"
  | "chevron-down"
  | "external-link"
  | "folder"
  | "check-circle"
  | "lock"
  | "loader"
  | "eye"
  | "grid"
  | "target"
  | "accessibility"
  | "document"
  | "star"
  | "arrow-right"
  | "arrow-left"
  | "bulb"
  | "users"
  | "check"
  | "refresh"
  | "message"
  | "network"
  | "play-solid";

type Glyph = { outline: React.ReactNode; filled?: React.ReactNode };

const glyphs: Record<IconName, Glyph> = {
  bell: {
    outline: (
      <>
        <path d="M6 9a6 6 0 0 1 12 0v4l1.5 3h-15L6 13V9Z" />
        <path d="M10 19a2 2 0 0 0 4 0" />
      </>
    ),
    filled: (
      <>
        <path fill="currentColor" stroke="none" d="M6 9a6 6 0 0 1 12 0v4l1.5 3h-15L6 13V9Z" />
        <path d="M10 19a2 2 0 0 0 4 0" />
      </>
    ),
  },
  search: {
    outline: (
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </>
    ),
    filled: (
      <>
        <circle cx="11" cy="11" r="7" strokeWidth="3" />
        <path d="m20 20-3.5-3.5" strokeWidth="3" />
      </>
    ),
  },
  play: {
    outline: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M10 8.5v7l5.5-3.5L10 8.5Z" />
      </>
    ),
    filled: (
      <>
        <circle cx="12" cy="12" r="10" fill="currentColor" stroke="none" />
        <path d="M10 8.5v7l5.5-3.5L10 8.5Z" stroke="none" className="fill-on-primary" />
      </>
    ),
  },
  file: {
    outline: (
      <>
        <path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8l-4-5Z" />
        <path d="M14 3v5h4" />
        <path d="M9 13h6M9 17h6" />
      </>
    ),
    filled: (
      <>
        <path fill="currentColor" stroke="none" d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8l-4-5Z" />
        <path d="M9 13h6M9 17h6" className="stroke-on-primary" />
      </>
    ),
  },
  bookmark: {
    outline: <path d="M6 4h12v17l-6-4-6 4V4Z" />,
    filled: <path fill="currentColor" stroke="none" d="M6 4h12v17l-6-4-6 4V4Z" />,
  },
  chart: {
    outline: (
      <>
        <path d="M5 20V14" />
        <path d="M12 20V9" />
        <path d="M19 20V4" />
      </>
    ),
    filled: (
      <>
        <rect x="3.5" y="13" width="4" height="8" rx="1" fill="currentColor" stroke="none" />
        <rect x="10" y="8" width="4" height="13" rx="1" fill="currentColor" stroke="none" />
        <rect x="16.5" y="3" width="4" height="18" rx="1" fill="currentColor" stroke="none" />
      </>
    ),
  },
  clock: {
    outline: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    filled: (
      <>
        <circle cx="12" cy="12" r="10" fill="currentColor" stroke="none" />
        <path d="M12 7v5l3 2" className="stroke-on-primary" />
      </>
    ),
  },
  user: {
    outline: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21a8 8 0 0 1 16 0" />
      </>
    ),
    filled: (
      <>
        <circle cx="12" cy="8" r="4.5" fill="currentColor" stroke="none" />
        <path d="M4 21a8 8 0 0 1 16 0Z" fill="currentColor" stroke="none" />
      </>
    ),
  },
  "chevron-right": { outline: <path d="m9 5 7 7-7 7" /> },
  "chevron-left": { outline: <path d="m15 5-7 7 7 7" /> },
  "chevron-down": { outline: <path d="m5 9 7 7 7-7" /> },
  "external-link": {
    outline: (
      <>
        <path d="M14 4h6v6" />
        <path d="M20 4 11 13" />
        <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
      </>
    ),
  },
  folder: {
    outline: <path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6Z" />,
  },
  "check-circle": {
    outline: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="m8.5 12 2.5 2.5 4.5-5" />
      </>
    ),
  },
  lock: {
    outline: (
      <>
        <rect x="5" y="11" width="14" height="10" rx="2" />
        <path d="M8 11V8a4 4 0 0 1 8 0v3" />
      </>
    ),
  },
  loader: {
    outline: <path d="M12 3a9 9 0 1 1-6.36 2.64" />,
  },
  eye: {
    outline: (
      <>
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
  },
  grid: {
    outline: (
      <>
        <rect x="4" y="4" width="7" height="7" rx="1.5" />
        <rect x="13" y="4" width="7" height="7" rx="1.5" />
        <rect x="4" y="13" width="7" height="7" rx="1.5" />
        <rect x="13" y="13" width="7" height="7" rx="1.5" />
      </>
    ),
  },
  target: {
    outline: (
      <>
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="5" />
        <circle cx="12" cy="12" r="1" />
      </>
    ),
  },
  accessibility: {
    outline: (
      <>
        <circle cx="12" cy="4.5" r="1.5" />
        <path d="M4 9h16" />
        <path d="M12 9v6" />
        <path d="m12 15-3.5 6M12 15l3.5 6" />
      </>
    ),
  },
  document: {
    outline: (
      <>
        <path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8l-4-5Z" />
        <path d="M14 3v5h4" />
        <path d="M9 12h6M9 16h4" />
      </>
    ),
  },
  star: {
    outline: <path d="m12 3 2.7 5.6 6.3.9-4.5 4.4 1.1 6.1L12 17.1 6.4 20l1.1-6.1L3 9.5l6.3-.9L12 3Z" />,
    filled: <path fill="currentColor" d="m12 3 2.7 5.6 6.3.9-4.5 4.4 1.1 6.1L12 17.1 6.4 20l1.1-6.1L3 9.5l6.3-.9L12 3Z" />,
  },
  "arrow-right": {
    outline: (
      <>
        <path d="M4 12h16" />
        <path d="m13 5 7 7-7 7" />
      </>
    ),
  },
  "arrow-left": {
    outline: (
      <>
        <path d="M20 12H4" />
        <path d="m11 5-7 7 7 7" />
      </>
    ),
  },
  bulb: {
    outline: (
      <>
        <path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1.2 2.1h4.6c.2-.9.6-1.6 1.2-2.1A6 6 0 0 0 12 3Z" />
        <path d="M10 19h4" />
        <path d="M11 22h2" />
      </>
    ),
  },
  users: {
    outline: (
      <>
        <circle cx="9" cy="8" r="3.5" />
        <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
        <path d="M15.5 4.7a3.5 3.5 0 0 1 0 6.6" />
        <path d="M17.5 14.2a6.5 6.5 0 0 1 4 5.8" />
      </>
    ),
  },
  check: { outline: <path d="m5 12.5 4.5 4.5L19 7.5" /> },
  refresh: {
    outline: (
      <>
        <path d="M20 11a8 8 0 0 0-14.6-4.5L4 8" />
        <path d="M4 4v4h4" />
        <path d="M4 13a8 8 0 0 0 14.6 4.5L20 16" />
        <path d="M20 20v-4h-4" />
      </>
    ),
  },
  message: {
    outline: <path d="M4 5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9l-5 4V5Z" />,
  },
  network: {
    outline: (
      <>
        <circle cx="12" cy="5" r="2" />
        <circle cx="5" cy="19" r="2" />
        <circle cx="19" cy="19" r="2" />
        <path d="M12 7v5M12 12l-5.6 5.4M12 12l5.6 5.4" />
      </>
    ),
  },
  "play-solid": { outline: <path d="M8 5.5v13l10-6.5-10-6.5Z" fill="currentColor" /> },
};

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  /** Render the filled variant when one exists for this glyph. */
  filled?: boolean;
  /** Pixel size; defaults to the 24px grid. */
  size?: number;
}

/** Renders a named glyph from the shared icon set at the requested size. */
export function Icon({ name, filled = false, size = 24, className, ...props }: IconProps) {
  const glyph = glyphs[name];
  const body = (filled && glyph.filled) || glyph.outline;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("shrink-0", className)}
      {...props}
    >
      {body}
    </svg>
  );
}

export const iconNames = Object.keys(glyphs) as IconName[];
