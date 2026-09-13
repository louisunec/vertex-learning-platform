/** Features in the design that have no backend yet (goals and recommendations PR-11, reviews, practice PR-7). */
const UPCOMING = ["Learning goals", "Recommendations", "Reviews", "Practice"];

/** One quiet line instead of dead-end cards; nothing here is a link. Reviews drops out once its tab is on. */
export function ComingSoon({ reviews = false }: { reviews?: boolean }) {
  const upcoming = reviews ? UPCOMING.filter((label) => label !== "Reviews") : UPCOMING;
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
