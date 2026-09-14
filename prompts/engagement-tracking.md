# Engagement tracking: search, playback, resume, completion

> **Amended 2026-09-14 (PR-10, user decision):** `search_performed` and `search_result_clicked` no longer carry `query`. `search_performed` keeps `query_length`, `status`, `result_count`, and `course_count`. `search_result_clicked` keeps `result_type`, `lesson_slug`, `course_slug`, `start_seconds`, and `position`, and gains `query_length`. No code in the repository read `query`. PostHog insights built on it were not checkable without a personal API key. The rest of this record describes the original design.
>
> PR-10 also adds `lesson_id` and `video_id` to the player events, and `seek_tracking` to `video_played`.

## Goal

Add PostHog tracking for the learner features built after the initial analytics setup (`e5f255d`): search performed with a query, search result opened with its result type, video played, watch depth, resume used, and lessons completed. Reuse the existing PostHog setup (client `posthog-js` via `instrumentation-client.ts`, server `getPostHogClient()` inside `after()`) and existing snake_case event conventions. No new analytics model, no new dependencies.

## Guidance read

- `AGENTS.md` §2 (invariants), §3 (normal implementation gate), §8 (provider embeds + start-time), §11 (PostHog uses existing event patterns), §12 (verification), §13 (report).
- `CLAUDE.md` (plan → explicit approval before any change).
- `docs/VIDEO_PIPELINE.md` §9–10 (provider embeds only, no custom player).
- `prompts/lesson-page.md`, `prompts/search-results-page.md` (prior decisions on embeds and search analytics).
- At implementation time: installed Next.js docs under `node_modules/next/dist/docs/` for client components and `after()`.

## Code inspected

- `instrumentation-client.ts` — client init, `/ingest` proxy, `debug` in development.
- `lib/posthog-server.ts` — singleton server client; `app/lessons/[slug]/page.tsx` captures `lesson_viewed` in `after()` with `distinctId: userId ?? "anonymous"`.
- `components/home/posthog-identity.tsx` — Clerk identity sync, so client events join the signed-in user.
- `components/home/hero-search-form.tsx` — `search_submitted` (`query_length`), home form only.
- `app/search/page.tsx` — server-rendered `/search` form; captures nothing.
- `components/search/search-results.tsx` — `search_results_viewed` (`query_length`, `result_count`) on first successful page; nothing on error.
- `components/search/video-result-card.tsx`, `lesson-result-card.tsx` — `search_result_clicked` with `result_type`, `lesson_slug`, `course_slug` (+ `start_seconds` for video).
- `app/lessons/[slug]/page.tsx:49-56` — start position: valid `?t=` wins, else stored `resumeSeconds` when the progress row is not completed.
- `components/lesson/video-embed.tsx` — server-rendered plain iframe; no player events.
- `lib/video/embed.ts` + `embed.test.ts` — YouTube embed `https://www.youtube-nocookie.com/embed/{id}?rel=0[&start=N]`.
- `studio/scripts/seed/seed.ndjson` — all 120 seeded `videoUrl`s are YouTube.
- `studio/schemaTypes/documents/progress.ts`, `sanity/data/progress.ts`, `lib/course-progress.ts`, `app/api/` — progress is **read-only**: only `app/api/search` exists; no route writes `completed` or `resumeSeconds`.
- `components/course/course-hero-actions.tsx` — `course_started` / `course_continued` already captured.

## Current state vs. request

| Ask | State today | Change |
| --- | --- | --- |
| Search performed with a query | `search_submitted` (home only, length only); `search_results_viewed` (length, count) | New `search_performed` with query text, replacing `search_results_viewed` |
| Result opened with result type | Exists: `search_result_clicked` with `result_type` | Add `query` and `position` |
| Video played | Nothing | New `video_played` (YouTube) |
| Watch depth | Nothing | New `video_watch_depth` milestones (YouTube) |
| Resume used | Nothing (resume position is applied silently) | New server `resume_used`; `start_source` on `lesson_viewed` |
| Lessons completed | **No completion feature exists** — nothing a learner does marks a lesson complete | Needs a decision (see Decision 6) |

## Decisions / assumptions

1. **`search_performed` replaces `search_results_viewed`.** Fired once per query from `SearchResults` when the first page resolves — success or failure — so it covers both the home form and the `/search` form and shares the posthog-js distinct id used by `search_result_clicked` (a server-side capture in `/api/search` would land on `"anonymous"` and break the search → open funnel). Properties: `query` (trimmed, truncated to 200 chars), `query_length`, `status: "success" | "error"`, `result_count` (grounded `total`; `null` on error), `course_count`. Not fired for "Show more" pages. Firing both events at the same instant would be redundant; analytics only landed on 2026-09-09, so the rename loses little history. `search_submitted` on the home form stays unchanged.
2. **Raw query text is captured** (truncated to 200 chars). Search queries are learner-typed free text and may contain personal information — **needs your approval** (alternative: keep `query_length` only).
3. **`search_result_clicked` keeps its name and properties** and gains `query` and `position` (1-based index in the rendered list, across loaded pages). The capture moves into `SearchResults`, which passes an `onOpen` callback to each card; cards no longer import `posthog-js`.
4. **Player tracking is YouTube-only.** All seeded videos are YouTube, so only YouTube is verifiable. Vimeo and Bunny embeds render exactly as today and emit no play/depth events. Tracking attaches the official YouTube IFrame Player API to the provider's own iframe — still the provider embed, consistent with VIDEO_PIPELINE §9 ("no custom player").
   - `getEmbedSource` adds `enablejsapi=1` to YouTube URLs (required for the API); `embed.test.ts` YouTube expectations updated.
   - `VideoEmbed` becomes a client component. It loads `https://www.youtube.com/iframe_api` once (small loader, chains any existing `onYouTubeIframeAPIReady`), attaches `new YT.Player(iframe, { events })`, and uses minimal local `YT` type declarations (no `@types/youtube` dependency).
   - Load/attach failures are swallowed: the video still plays, only tracking is lost.
5. **Event definitions.**
   - `video_played` — first transition to PLAYING per page view. Properties: `lesson_slug`, `course_slug`, `provider: "youtube"`, `start_seconds`, `start_source`, `duration_seconds`.
   - `video_watch_depth` — milestones `depth_percent` ∈ {25, 50, 75, 90}, each at most once per page view. Rule: a milestone fires when the player's position reaches it (polled every 1 s while PLAYING, and checked on ENDED); **milestones at or below the start position are skipped**, so a learner deep-linked or resumed at 60 % never "reaches" 25/50. Position-based: seeking forward past a milestone counts as reaching it. Same properties as `video_played` plus `depth_percent`, `position_seconds`. Milestone math is a pure function in `lib/video/watch-depth.ts`, covered by `node --test`.
   - `start_source` = `"deeplink"` (valid `?t=`), `"resume"` (stored `resumeSeconds > 0` applied), or `"beginning"`. Computed on the lesson page server and passed to `VideoEmbed`.
6. **Lessons completed — needs your decision.** There is no completion write path (no progress API route; `completed` exists only in seed data), so there is no real completion to track. Options:
   - **(a) Recommended:** analytics-only `lesson_completed` fired once per page view when the video reaches the 90 % milestone, with `completion_basis: "watch_depth_90"`. It does **not** write progress or change the UI's completed state. The explicit basis lets a future server-side "real" completion event coexist without collision.
   - (b) Defer completion tracking until a progress-write feature exists.
   - (c) Build the authenticated progress-write route first — a separate high-risk task with its own prompt.
7. **`resume_used`** is captured server-side in the lesson page's existing `after()` block, only when `start_source === "resume"`. The learner is always signed in there, so `distinctId` is the Clerk user id. Properties: `lesson_slug`, `course_slug`, `resume_seconds`. `lesson_viewed` gains `start_source`. It measures "opened the lesson at the stored resume position", independent of whether player tracking loads.

## Expected files

- `prompts/engagement-tracking.md` — this prompt.
- `components/search/search-results.tsx` — `search_performed` (replaces `search_results_viewed`); `onOpen` handler capturing `search_result_clicked` with `query` + `position`.
- `components/search/video-result-card.tsx`, `components/search/lesson-result-card.tsx` — accept `onOpen`; remove inline `posthog` capture.
- `lib/video/embed.ts` — `enablejsapi=1` on YouTube embeds.
- `lib/video/embed.test.ts` — updated YouTube expectations.
- `lib/video/watch-depth.ts` (new) — pure milestone function.
- `lib/video/watch-depth.test.ts` (new) — milestone tests.
- `lib/video/youtube-iframe-api.ts` (new) — one-time API loader + minimal `YT` types.
- `components/lesson/video-embed.tsx` — client component; YouTube play/depth/(completion) tracking.
- `app/lessons/[slug]/page.tsx` — `start_source`, `resume_used`, `lesson_viewed.start_source`, tracking props to `VideoEmbed`.

## Requirements

- Event names and properties exactly as above; snake_case, matching existing events.
- Each per-page-view event (`video_played`, each depth milestone, `lesson_completed` if approved) fires at most once per lesson page mount, including under React Strict Mode double effects.
- Interval and player listeners cleaned up on unmount; no polling while paused/ended.
- No change to rendered markup, layout, or playback behavior besides the `enablejsapi=1` query param.
- No new npm dependencies; no new env vars.

## Security considerations

- No new credentials; all client events use the existing public project token via `/ingest`.
- New third-party script: YouTube IFrame API from `www.youtube.com`, loaded only on lesson pages with a YouTube video. No CSP is configured today, so nothing to update.
- Search query text sent to PostHog (Decision 2).
- Server `resume_used` sends only lesson/course slugs and a second count — no transcript or content payloads.

## Acceptance criteria

- `/search?q=…` (from either form) emits one `search_performed` with query, status, and counts; an API failure emits it with `status: "error"`.
- Clicking a result emits `search_result_clicked` with `result_type`, `query`, `position`.
- Playing a YouTube lesson video emits one `video_played`; watching past 25/50/75/90 % emits each `video_watch_depth` once; milestones below the start position never fire.
- Opening a lesson with an incomplete stored `resumeSeconds > 0` and no `?t=` emits `resume_used`; `lesson_viewed.start_source` is correct for all three sources.
- `lesson_completed` behaves per the approved option in Decision 6.
- Vimeo/Bunny embeds unchanged.

## Checks

- `npm test`
- `npm run typecheck`
- `npm run lint`
- `npm run build` (client component, external script, embed URL change)

## Manual tests

1. `npm run dev`, open DevTools console (posthog-js `debug` logs captures in development).
2. Home → search "react hooks" → one `search_performed` (`status: "success"`, `query`, `result_count`). Repeat from the `/search` form → another `search_performed`.
3. Click the 2nd result → `search_result_clicked` with `position: 2` and the matching `result_type`.
4. On the lesson page press play → one `video_played` with `start_source: "beginning"`. Scrub to ~30 % → `video_watch_depth` 25 once. Pause/play again → no second `video_played`.
5. Open a video result (`?t=` deep link) → `video_played` with `start_source: "deeplink"`; milestones at or below the start never fire.
6. Signed in as a learner whose seeded progress row is incomplete with `resumeSeconds > 0`, open that lesson without `?t=` → server `resume_used` and `lesson_viewed.start_source: "resume"` in PostHog Live events.
7. Scrub past 90 % → `lesson_completed` (`completion_basis: "watch_depth_90"`) if option (a) is approved.
