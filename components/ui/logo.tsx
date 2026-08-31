import { cn } from "@/lib/cn";

export interface LogoProps {
  /** Mark height in px; the wordmark scales with it. */
  size?: number;
  /** Hide the "Vertex" wordmark and render only the mark. */
  markOnly?: boolean;
  className?: string;
}

export function VertexMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cn("shrink-0", className)}
    >
      <path d="M2 3h20L12 21 2 3Z" fill="var(--color-primary-500)" />
      <path d="M8.5 3h7L12 9.5 8.5 3Z" fill="var(--color-primary-300)" />
      <path d="M12 9.5 15.5 3h4L12 16 4.5 3h4L12 9.5Z" fill="var(--color-white)" fillOpacity="0.22" />
    </svg>
  );
}

export function Logo({ size = 28, markOnly = false, className }: LogoProps) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)} aria-label="Vertex">
      <VertexMark size={size} />
      {!markOnly && (
        <span
          className="font-sans font-semibold tracking-tight text-neutral-900"
          style={{ fontSize: size * 0.82, lineHeight: 1 }}
        >
          Vertex
        </span>
      )}
    </span>
  );
}
