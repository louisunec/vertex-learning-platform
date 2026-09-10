import type { Metadata } from "next";
import { Icon } from "@/components/ui";
import { SiteHeader } from "@/components/home/site-header";
import { SearchResults } from "@/components/search/search-results";

export const metadata: Metadata = {
  title: "Search",
  description: "Search Vertex lessons and video moments.",
};

type Props = {
  searchParams: Promise<{ q?: string | string[] }>;
};

/**
 * Structured search results page (not a chatbox). The shell renders the
 * heading and the pre-filled query form; the client component fetches
 * `/api/search`, renders validated lesson/video cards, and slots the form
 * between the grounded summary line and the results toolbar.
 */
export default async function SearchPage({ searchParams }: Props) {
  const sp = await searchParams;
  const query = (Array.isArray(sp.q) ? sp.q[0] : sp.q)?.trim() ?? "";

  const form = (
    <form
      role="search"
      action="/search"
      className="mx-auto flex h-14 w-full max-w-[720px] items-center gap-3 rounded-lg border border-neutral-200 bg-white pr-3 pl-5 shadow-sm transition-colors focus-within:border-primary-400"
    >
      <Icon name="search" size={20} className="shrink-0 text-neutral-900" />
      <input
        type="search"
        name="q"
        defaultValue={query}
        aria-label="Search lessons and video moments"
        placeholder="Search lessons and video moments..."
        className="h-full min-w-0 flex-1 bg-transparent text-body-lg text-neutral-900 outline-none placeholder:text-neutral-500"
      />
      <kbd className="hidden h-9 shrink-0 items-center rounded-sm border border-neutral-200 px-3 font-sans text-body text-neutral-900 sm:inline-flex">
        ⌘ K
      </kbd>
    </form>
  );

  return (
    <div className="bg-hatch flex flex-1 flex-col">
      <div className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col border-x border-neutral-200 bg-canvas">
        <SiteHeader />

        <main className="flex flex-1 flex-col px-6 pt-12 pb-16 md:px-12" aria-labelledby="search-heading">
          <p className="mx-auto inline-flex h-7 items-center rounded-sm bg-primary-100 px-3 text-small font-semibold tracking-wider text-primary-500 uppercase">
            Search results
          </p>

          <h1
            id="search-heading"
            className="mt-5 text-center font-display text-[38px] leading-[46px] font-normal text-balance text-neutral-900 sm:text-[44px] sm:leading-[52px]"
          >
            {query ? (
              <>
                Results for <span className="text-primary-500">“{query}”</span>
              </>
            ) : (
              "Search"
            )}
          </h1>

          {query ? (
            <div className="mt-4">
              <SearchResults key={query} query={query}>
                {form}
              </SearchResults>
            </div>
          ) : (
            <div className="mt-8 flex flex-col gap-6">
              {form}
              <p className="text-center text-body-lg text-neutral-500">
                Ask anything about your learning — lessons and exact video moments will show up here.
              </p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
