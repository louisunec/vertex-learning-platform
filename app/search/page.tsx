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
 * pre-filled query form; the client component fetches `/api/search` and
 * renders validated lesson/video cards.
 */
export default async function SearchPage({ searchParams }: Props) {
  const sp = await searchParams;
  const query = (Array.isArray(sp.q) ? sp.q[0] : sp.q)?.trim() ?? "";

  return (
    <div className="bg-hatch flex flex-1 flex-col">
      <div className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col border-x border-neutral-200 bg-canvas">
        <SiteHeader />

        <main className="flex flex-1 flex-col px-6 pt-10 pb-16 md:px-12" aria-labelledby="search-heading">
          <h1 id="search-heading" className="font-display text-[28px] leading-9 font-normal text-neutral-900">
            Search
          </h1>

          <form
            role="search"
            action="/search"
            className="mt-6 flex h-14 w-full max-w-[720px] items-center gap-3 rounded-lg border border-neutral-200 bg-white px-5 shadow-sm transition-colors focus-within:border-primary-400"
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
          </form>

          <div className="mt-8">
            {query ? (
              <SearchResults key={query} query={query} />
            ) : (
              <p className="text-body-lg text-neutral-500">
                Ask anything about your learning — lessons and exact video moments will show up here.
              </p>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
