"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import posthog from "posthog-js";
import { Button, Icon, Select } from "@/components/ui";
import { pluralize } from "@/lib/format";
import { LessonResultCard } from "./lesson-result-card";
import { VideoResultCard } from "./video-result-card";
import type { SearchResponse, SearchResult } from "@/lib/search/schema";

type Status = "loading" | "loaded" | "error";

/** Upper bound on query text sent to analytics. */
const MAX_TRACKED_QUERY_CHARS = 200;

/**
 * Fetches server-validated structured results from `/api/search` and renders
 * the results section. The client renders only what the canonical server
 * contract returned — no conversational prose, no fabricated counts.
 *
 * `children` is the server-rendered search form, slotted between the grounded
 * summary line and the results toolbar so the form still works without JS.
 */
export function SearchResults({ query, children }: { query: string; children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [courseCount, setCourseCount] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const searchTracked = useRef(false);

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
    // Once per query, from either search form; "Show more" pages are not new searches.
    const trackSearch = (outcome: { status: "success" | "error"; resultCount: number | null; courseCount: number | null }) => {
      if (searchTracked.current) return;
      searchTracked.current = true;
      posthog.capture("search_performed", {
        query: query.slice(0, MAX_TRACKED_QUERY_CHARS),
        query_length: query.length,
        status: outcome.status,
        result_count: outcome.resultCount,
        course_count: outcome.courseCount,
      });
    };
    fetchPage(null)
      .then((page) => {
        if (cancelled) return;
        setResults(page.results);
        setTotal(page.total);
        setCourseCount(page.courseCount);
        setNextCursor(page.nextCursor);
        setStatus("loaded");
        trackSearch({ status: "success", resultCount: page.total, courseCount: page.courseCount });
      })
      .catch(() => {
        if (cancelled) return;
        setStatus("error");
        trackSearch({ status: "error", resultCount: null, courseCount: null });
      });
    return () => {
      cancelled = true;
    };
  }, [fetchPage, query]);

  const showMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setMoreError(false);
    try {
      const page = await fetchPage(nextCursor);
      setResults((prev) => [...prev, ...page.results]);
      setTotal(page.total);
      setCourseCount(page.courseCount);
      setNextCursor(page.nextCursor);
    } catch {
      // Keep the results already on screen; only the follow-up page failed.
      setMoreError(true);
    } finally {
      setLoadingMore(false);
    }
  };

  /** `position` is 1-based across all loaded pages. */
  const openResult = (result: SearchResult, position: number) => {
    posthog.capture("search_result_clicked", {
      result_type: result.type,
      lesson_slug: result.slug,
      course_slug: result.course?.slug ?? null,
      ...(result.type === "video" ? { start_seconds: result.startSeconds } : {}),
      query: query.slice(0, MAX_TRACKED_QUERY_CHARS),
      position,
    });
  };

  const hasResults = status === "loaded" && results.length > 0;

  return (
    <div className="flex flex-col">
      {hasResults && (
        <p className="text-center text-body-lg text-neutral-500">
          Found {pluralize(total, "result")}
          {courseCount > 0 && <> across {pluralize(courseCount, "course")}</>}
        </p>
      )}

      <div className="mt-6">{children}</div>

      {status === "loading" && (
        <p
          className="mt-10 inline-flex items-center justify-center gap-2 text-body-lg text-neutral-500"
          role="status"
        >
          <Icon name="loader" size={18} className="animate-spin text-neutral-400" aria-hidden />
          Searching lessons and video moments…
        </p>
      )}

      {status === "error" && (
        <p className="mt-10 text-center text-body-lg text-neutral-500" role="alert">
          Search is temporarily unavailable. Try again in a moment, or{" "}
          <Link href="/courses" className="text-primary-500 underline-offset-2 hover:underline">
            browse all courses
          </Link>
          .
        </p>
      )}

      {status === "loaded" && results.length === 0 && (
        <p className="mt-10 text-center text-body-lg text-neutral-900">No matches for “{query}”.</p>
      )}

      {hasResults && (
        <>
          <div className="mt-9 flex items-center justify-between gap-4">
            <p className="text-h2 text-neutral-900">{pluralize(total, "result")}</p>
            <Select
              aria-label="Sort results"
              className="w-[180px]"
              value="relevance"
              onChange={() => undefined}
              options={[{ value: "relevance", label: "Most Relevant" }]}
            />
          </div>

          <ul aria-label="Search results" className="mt-5 flex flex-col gap-4">
            {results.map((result, index) => (
              <li key={result.href}>
                {result.type === "video" ? (
                  <VideoResultCard result={result} onOpen={() => openResult(result, index + 1)} />
                ) : (
                  <LessonResultCard result={result} onOpen={() => openResult(result, index + 1)} />
                )}
              </li>
            ))}
          </ul>

          {nextCursor && (
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <Button variant="secondary" onClick={showMore} disabled={loadingMore}>
                {loadingMore ? "Loading…" : "Show more results"}
              </Button>
              {moreError && (
                <p className="text-body text-neutral-500" role="alert">
                  Couldn’t load more results. Try again.
                </p>
              )}
            </div>
          )}
        </>
      )}

      {status === "loaded" && (
        <div className="mt-6 flex flex-col items-center justify-between gap-4 rounded-lg border border-primary-200/60 bg-primary-100/50 p-5 sm:flex-row sm:gap-6">
          <div className="flex items-center gap-4">
            <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary-100 text-primary-500">
              <Icon name="search" size={22} aria-hidden />
            </span>
            <div className="flex flex-col gap-1">
              <p className="text-body-lg font-semibold text-neutral-900">
                Can’t find what you’re looking for?
              </p>
              <p className="text-body-lg text-neutral-500">
                Try different keywords or browse our full course catalog.
              </p>
            </div>
          </div>
          <Link
            href="/courses"
            className="inline-flex h-11 shrink-0 items-center gap-3 rounded-md border border-primary-200/70 bg-surface px-4 text-body-lg font-medium text-primary-500 transition-colors hover:border-primary-400 hover:text-primary-600 focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:outline-none"
          >
            Browse all courses
            <Icon name="arrow-right" size={18} aria-hidden />
          </Link>
        </div>
      )}
    </div>
  );
}
