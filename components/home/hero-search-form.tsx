"use client";

import posthog from "posthog-js";
import { Icon } from "@/components/ui";

/**
 * Client component for the homepage hero search form. Captures the
 * `search_submitted` event before navigating to /search.
 */
export function HeroSearchForm() {
  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    const query = new FormData(e.currentTarget).get("q");
    posthog.capture("search_submitted", {
      query_length: typeof query === "string" ? query.length : 0,
    });
  };

  return (
    <form
      role="search"
      action="/search"
      onSubmit={handleSubmit}
      className="mx-auto mt-11 flex h-16 w-full max-w-[880px] items-center gap-3 rounded-lg border border-neutral-200 bg-white pr-5 pl-5 shadow-sm transition-colors focus-within:border-primary-400 sm:h-20 sm:gap-4 sm:pl-7"
    >
      <Icon name="search" size={26} className="shrink-0 text-neutral-900" />
      <input
        type="search"
        name="q"
        aria-label="Ask anything about your learning"
        placeholder="Ask anything about your learning..."
        className="h-full min-w-0 flex-1 bg-transparent text-[17px] text-neutral-900 outline-none placeholder:text-neutral-500 sm:text-[19px]"
      />
      <kbd className="hidden h-11 shrink-0 items-center rounded-sm border border-neutral-200 px-3 font-sans text-[16px] text-neutral-900 sm:inline-flex">
        ⌘ K
      </kbd>
    </form>
  );
}
