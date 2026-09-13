import Link from "next/link";
import { cn } from "@/lib/cn";

export type LearningTab = "overview" | "knowledge-map" | "reviews";

/**
 * My Learning sub-navigation. Knowledge map and Reviews are links only when
 * their flags are on for this learner; otherwise they are shown disabled,
 * never linked.
 */
export function LearningTabs({
  active,
  knowledgeMap = false,
  reviews = false,
}: {
  active: LearningTab;
  knowledgeMap?: boolean;
  reviews?: boolean;
}) {
  const tabs = [
    { key: "overview", label: "Overview", href: "/my-learning" },
    { key: "knowledge-map", label: "Knowledge map", href: knowledgeMap ? "/my-learning/knowledge-map" : null },
    { key: "reviews", label: "Reviews", href: reviews ? "/my-learning/reviews" : null },
  ] as const;

  return (
    <nav aria-label="My Learning" className="border-b border-neutral-200 px-6 md:px-12">
      <ul className="flex gap-8 overflow-x-auto">
        {tabs.map((tab) => (
          <li key={tab.key}>
            {tab.href ? (
              <Link
                href={tab.href}
                aria-current={tab.key === active ? "page" : undefined}
                className={cn(
                  "relative inline-flex h-[52px] items-center text-body font-medium whitespace-nowrap",
                  tab.key === active
                    ? "text-primary-500 after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-primary-500"
                    : "text-neutral-700 hover:text-neutral-900",
                )}
              >
                {tab.label}
              </Link>
            ) : (
              <span
                aria-disabled="true"
                title="Not available yet"
                className="inline-flex h-[52px] cursor-not-allowed items-center text-body font-medium whitespace-nowrap text-neutral-500"
              >
                {tab.label}
              </span>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}
