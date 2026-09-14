/** Features in the design that may not be on yet (goals and recommendations PR-11, reviews, practice as PR-7's lesson checks). */
const UPCOMING = ["Learning goals", "Recommendations", "Reviews", "Practice"];

/**
 * One quiet line instead of dead-end cards; nothing here is a link. Reviews
 * drops out once its tab is on, goals and recommendations once next actions
 * are on, and practice once lesson checks are on. With nothing left, it
 * renders nothing.
 */
export function ComingSoon({
  reviews = false,
  nextAction = false,
  lessonChecks = false,
}: {
  reviews?: boolean;
  nextAction?: boolean;
  lessonChecks?: boolean;
}) {
  const hidden = new Set([
    ...(reviews ? ["Reviews"] : []),
    ...(nextAction ? ["Learning goals", "Recommendations"] : []),
    ...(lessonChecks ? ["Practice"] : []),
  ]);
  const upcoming = UPCOMING.filter((label) => !hidden.has(label));
  if (upcoming.length === 0) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-small text-neutral-500">
      <span className="font-medium tracking-[0.14em] uppercase">Coming soon</span>
      {upcoming.map((label) => (
        <span key={label} className="rounded-xs border border-neutral-200 px-2 py-0.5">
          {label}
        </span>
      ))}
    </p>
  );
}
