import Link from "next/link";

/** Pages that exist only in the design so far; shown disabled, never linked. */
const upcoming = ["Knowledge map", "Reviews"];

/** My Learning sub-navigation. Overview is the only page that exists. */
export function LearningTabs() {
  return (
    <nav aria-label="My Learning" className="border-b border-neutral-200 px-6 md:px-12">
      <ul className="flex gap-8 overflow-x-auto">
        <li>
          <Link
            href="/my-learning"
            aria-current="page"
            className="relative inline-flex h-[52px] items-center text-body font-medium whitespace-nowrap text-primary-500 after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-primary-500"
          >
            Overview
          </Link>
        </li>
        {upcoming.map((label) => (
          <li key={label}>
            <span
              aria-disabled="true"
              title="Not available yet"
              className="inline-flex h-[52px] cursor-not-allowed items-center text-body font-medium whitespace-nowrap text-neutral-500"
            >
              {label}
            </span>
          </li>
        ))}
      </ul>
    </nav>
  );
}
