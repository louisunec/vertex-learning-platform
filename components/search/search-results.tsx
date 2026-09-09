"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import posthog from "posthog-js";
import { Button, Icon } from "@/components/ui";
import { LessonResultCard } from "./lesson-result-card";
import { VideoResultCard } from "./video-result-card";
import type { SearchResponse, SearchResult } from "@/lib/search/schema";

type Status = "loading" | "loaded" | "error";

/**
 * Fetches server-validated structured results from `/api/search` and renders
 * cards. The client renders only what the canonical server contract returned —
 * no conversational prose, no fabricated counts.
 */
export function SearchResults({ query }: { query: string }) {
  const [status, setStatus] = useState<Status>("loading");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const viewTracked = useRef(false);

  const fetchPage = useCallback(
    async (cursor: string | null) => {
      const params = new URLSearchParams({ q: query });
      if (cursor) params.set("cursor", cursor);
      const res = await fetch(`/api/search?${params}`);
      if (!res.ok) throw new Error(`search failed: ${res.status}`);
      return (await res.json()) as SearchResponse;
    },
    [query],
  );

  // The page remounts this component per query (`key={query}`), so the
  // initial "loading" state is always fresh here.
  useEffect(() => {
    let cancelled = false;
    fetchPage(null)
      .then((page) => {
        if (cancelled) return;
        setResults(page.results);
        setTotal(page.total);
        setNextCursor(page.nextCursor);
        setStatus("loaded");
        if (!viewTracked.current) {
          viewTracked.current = true;
          posthog.capture("search_results_viewed", {
            query_length: query.length,
            result_count: page.total,
          });
        }
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [fetchPage, query]);

  const showMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchPage(nextCursor);
      setResults((prev) => [...prev, ...page.results]);
      setTotal(page.total);
      setNextCursor(page.nextCursor);
    } catch {
      setStatus("error");
    } finally {
      setLoadingMore(false);
    }
  };

  if (status === "loading") {
    return (
      <p className="inline-flex items-center gap-2 text-body-lg text-neutral-500" role="status">
        <Icon name="loader" size={18} className="animate-spin text-neutral-400" aria-hidden />
        Searching lessons and video moments…
      </p>
    );
  }

  if (status === "error") {
    return (
      <p className="text-body-lg text-neutral-500" role="alert">
        Search is temporarily unavailable. Try again in a moment, or{" "}
        <Link href="/courses" className="text-primary-500 underline-offset-2 hover:underline">
          browse all courses
        </Link>
        .
      </p>
    );
  }

  if (results.length === 0) {
    return (
      <div className="flex max-w-[560px] flex-col gap-3">
        <p className="text-body-lg text-neutral-900">No matches for “{query}”.</p>
        <p className="text-body text-neutral-500">
          Try different keywords, or{" "}
          <Link href="/courses" className="text-primary-500 underline-offset-2 hover:underline">
            browse the full course catalog
          </Link>
          .
        </p>
      </div>
    );
  }

  return (
    <section aria-label="Search results" className="flex max-w-[860px] flex-col gap-5">
      <p className="text-small text-neutral-500">
        {total} result{total === 1 ? "" : "s"} for “{query}”
      </p>
      <ul className="flex flex-col gap-4">
        {results.map((result) => (
          <li key={result.href}>
            {result.type === "video" ? <VideoResultCard result={result} /> : <LessonResultCard result={result} />}
          </li>
        ))}
      </ul>
      {nextCursor && (
        <div>
          <Button variant="secondary" onClick={showMore} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Show more results"}
          </Button>
        </div>
      )}
    </section>
  );
}
