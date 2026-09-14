/** Features in the design that have no backend yet (goals and recommendations PR-11, reviews PR-9, practice PR-7). */
const upcoming = ["Learning goals", "Recommendations", "Reviews", "Practice"];

/** One quiet line instead of dead-end cards; nothing here is a link. */
export function ComingSoon() {
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
