import { cn } from "@/lib/cn";

/**
 * Brand tiles used by the catalog course cards. Each fills its parent
 * (the card's tile slot sets the size) and is decorative.
 */
type LogoProps = { className?: string };

export function NextjsLogo({ className }: LogoProps) {
  return (
    <svg viewBox="0 0 72 72" aria-hidden="true" className={cn("size-full", className)}>
      <defs>
        <linearGradient id="nextjs-stem" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0.45" stopColor="#fff" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="nextjs-diag" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0.7" stopColor="#fff" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="72" height="72" rx="14" fill="#0a0a0a" />
      {/* Left stem, diagonal that runs past the baseline, right stem fading out — the Next.js "N". */}
      <path d="M22 54V19" stroke="#fff" strokeWidth="6.5" />
      <path d="M22 19l30 40" stroke="url(#nextjs-diag)" strokeWidth="6.5" />
      <path d="M50 19v27" stroke="url(#nextjs-stem)" strokeWidth="6.5" />
    </svg>
  );
}

export function DockerLogo({ className }: LogoProps) {
  const box = { width: 9, height: 8, rx: 1, fill: "#e6f0ff", stroke: "#1d63ed", strokeWidth: 1.6 } as const;
  return (
    <svg viewBox="0 0 72 72" aria-hidden="true" className={cn("size-full", className)}>
      {/* container stack */}
      <rect x="14" y="30" {...box} />
      <rect x="25" y="30" {...box} />
      <rect x="36" y="30" {...box} />
      <rect x="47" y="30" {...box} />
      <rect x="25" y="20" {...box} />
      <rect x="36" y="20" {...box} />
      <rect x="36" y="10" {...box} />
      {/* body */}
      <path
        d="M6 40h56.5c3 0 5.5 2.4 5 5.4C66 56 57 63 43 63H28C16 63 8.5 55.5 6 44V40Z"
        fill="#1d63ed"
      />
      {/* tail fin */}
      <path d="M6 40c-3.5-1-5.5-4.5-4.5-8.5C4 33 6 35 6 40Z" fill="#1d63ed" />
      {/* eye */}
      <circle cx="56" cy="46.5" r="1.8" fill="#fff" />
    </svg>
  );
}

export function TypeScriptLogo({ className }: LogoProps) {
  return (
    <svg viewBox="0 0 72 72" aria-hidden="true" className={cn("size-full", className)}>
      <rect width="72" height="72" rx="14" fill="#3178c6" />
      <text
        x="36"
        y="47"
        textAnchor="middle"
        fontFamily="var(--font-inter), Inter, Arial, sans-serif"
        fontWeight="700"
        fontSize="31"
        letterSpacing="-0.5"
        fill="#fff"
      >
        TS
      </text>
    </svg>
  );
}
