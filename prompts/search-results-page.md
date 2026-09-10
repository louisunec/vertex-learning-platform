# Search results page

## Goal

Rebuild `/search` to match `design/vertex-search.png`, wired to the existing grounded Sanity/MCP search pipeline. The page keeps its current architecture (server shell → client fetch of `/api/search` → Zod-validated structured cards) and gains the reference layout: eyebrow + serif result heading, grounded "Found N results across M courses" line, centered search field with `⌘ K`, a results toolbar, full-width result rows with thumbnails, and a "Can't find what you're looking for?" CTA.

## Guidance read

- `AGENTS.md` §2 (invariants: grounded search, no fabricated counts), §4 (reference image is the source of truth for desktop layout), §9 (search architecture: server-side deterministic ranking, canonical Zod contract, bounded pagination), §12 (verification), §13 (completion report).
- `CLAUDE.md` (plan → explicit approval gate before any project file changes).
- `design/vertex-search.png` — the reference; inspected at full resolution for the hero, a video row, the lesson rows, and the footer CTA.

## Code inspected

- `app/search/page.tsx` — current server shell: reads `searchParams.q`, renders `SiteHeader`, an `h1`, a plain `form action="/search"`, and `<SearchResults key={query} query={query} />`.
- `components/search/search-results.tsx` — client component: paginated `fetch('/api/search')`, `search_results_viewed` capture, loading/error/empty states, "Show more results".
- `components/search/video-result-card.tsx`, `lesson-result-card.tsx` — current card markup and `search_result_clicked` captures.
- `lib/search/schema.ts` — canonical contract: `searchCourseContextSchema` (`id`, `title`, `slug`, `level`, `moduleTitle`, `position`), lesson/video result schemas, `searchResponseSchema` (`query`, `results`, `total`, `nextCursor`), cursor encode/decode.
- `lib/search/queries.ts` — `courseContextProjection` (used by the lesson query and `LESSON_VIDEO_INDEX_QUERY`) and `buildCourseCandidatesQuery` (its own inline course projection).
- `lib/search/retrieve.ts` — `courseRawSchema`, `courseRowSchema`, `toCourseContext()`, and the inline course context built in `parseCourseCandidates()` (two construction sites).
- `lib/search/rank.ts` — deterministic scoring; `toLessonResult` / `toVideoResult` build the result objects (`description`, `keyPoints`, `href`, `momentLabel`).
- `lib/search/search.ts` — pipeline and page slicing; `ranked` holds the full ordered set before the page slice.
- `lib/search/rank.test.ts` — fixtures use `course: null`, so a new course-context field needs no fixture change.
- `components/ui/*` — `Card`, `Badge` (`video` = primary-100/primary-500, `lesson` = lesson-bg/lesson), `Icon` (`search`, `play`, `file`, `folder`, `check-circle`, `chevron-right`, `external-link`, `arrow-right`, `loader`), `Button`, `Select` (44px field, chevron, `options` prop).
- `components/home/course-cover-tile.tsx` — how a missing Sanity asset is handled (neutral tile, never an invented logo).
- `app/globals.css` — design tokens (`font-display`, `--color-primary-*`, `--color-canvas`, `bg-hatch`, type scale).
- `studio/schemaTypes/documents/course.ts` — `coverImage` is the course's only image field (used as the row's course icon).
- `next.config.ts` — `cdn.sanity.io/images/**` already allowed for `next/image`.

## Decisions / assumptions

1. **"Found N results across M courses" is grounded.** `M` = distinct `course.id` across the **full ranked set** (not the current page), computed server-side in `lib/search/search.ts` and returned as a new `courseCount` field on the canonical response. Computing it over the whole ranked set keeps it stable across cursor pages. Nothing is counted that the ranked set does not contain.
2. **Course icon comes from `course.coverImage`.** `searchCourseContextSchema` gains `coverImageUrl: string | null`, projected in both GROQ course projections. When null, render a neutral rounded square (mirroring `CourseCoverTile`'s no-asset behavior) — never a placeholder logo.
3. **Video row thumbnail timestamp = `startSeconds`,** matching the "Watch from 12:45" action in the reference, not the lesson's total duration. Stated explicitly so it is not "corrected" later.
4. **Sort control renders the single grounded option, "Most Relevant".** Ranking authority is deterministic server-side logic (AGENTS §9); additional sort modes would be behavior the server does not rank for. The reference shows only this label. Rendered with the existing `Select`, disabled, so the control matches the design without implying unavailable behavior.
5. **The check circle on lesson tiles is decorative,** per the reference. Wiring it to real learner `progress` is auth-dependent and a separate feature; not in scope here. Styled with the existing `check-circle` glyph in a `bg-neutral-700 text-white` round wrapper — no new icon glyph.
6. **Lesson tile bullets** = `keyPoints.slice(0, 3)` (the contract already caps at 4). When a lesson has no key points, the tile shows the course icon only — no invented bullets.
7. **"Module N" on lesson rows** derives from `course.position` (`"5.1"` → `Module 5`); omitted when `position` is null. Video rows show `Lesson {position}` + `{moduleTitle}` exactly as stored, each omitted when null.
8. **Component structure.** The server page keeps ownership of the eyebrow, the serif `h1`, and the `<form>` (so search still works without JS); the form is passed to the client `SearchResults` as `children` and rendered in the slot between the summary line and the toolbar. Order in the client: summary → form slot → toolbar → rows → load more → CTA.
9. **Empty query** (`/search` with no `q`): heading is plain "Search", no summary line, no toolbar, no CTA; the existing invitation copy stays.
10. **Loading / error / empty-result states** keep their current semantics (`role="status"` / `role="alert"`, links to `/courses`), restyled to the new centered layout. The CTA card doubles as the no-results action, matching the reference.
11. **Analytics unchanged** — `search_results_viewed` and `search_result_clicked` keep their existing event names and properties.

## Expected files

- `prompts/search-results-page.md` — this prompt.
- `lib/search/schema.ts` — add `coverImageUrl` to `searchCourseContextSchema`; add `courseCount` to `searchResponseSchema`.
- `lib/search/queries.ts` — project `"coverImageUrl": coverImage.asset->url` in `courseContextProjection` **and** in `buildCourseCandidatesQuery`.
- `lib/search/retrieve.ts` — accept `coverImageUrl` on `courseRawSchema` + `courseRowSchema`; map it in `toCourseContext()` **and** in the inline course object in `parseCourseCandidates()`.
- `lib/search/search.ts` — compute `courseCount` from the full `ranked` set; include it in both the empty-terms early return and the final response.
- `app/search/page.tsx` — eyebrow badge, centered serif heading with the quoted query in primary, centered search form with `⌘ K`, form passed as `children` to `SearchResults`.
- `components/search/search-results.tsx` — summary line, form slot, toolbar (`N results` + sort `Select`), row list, load more, CTA card; restyled states.
- `components/search/video-result-card.tsx` — row layout: poster thumbnail with play overlay + timestamp badge, course icon + title, `VIDEO` badge, title, description, `Lesson X.Y` · module meta, "Watch from mm:ss ›".
- `components/search/lesson-result-card.tsx` — row layout: key-points tile with course icon + decorative check, course icon + title, `LESSON` badge, title, description, `Module N`, "View lesson ⧉ ›".
- `components/search/search-course-icon.tsx` (new, small) — 24px course cover icon with the neutral no-asset fallback, shared by both rows.

## Requirements

- Desktop fidelity to the reference: page column `max-w-[1200px]` with hatched margins and `SiteHeader` (unchanged); hero centered; search field centered at ~`max-w-[720px]`; result rows fill the content column.
- Rows are cards (`rounded-lg border border-neutral-200 bg-white`) with the thumbnail/tile on the left (16:9, ~`w-[275px]`) and content on the right; badge top-right; action bottom-right in primary.
- Below `md`, rows stack (thumbnail above content) and the hero scales down — smallest sensible adaptation, no redesign.
- The whole row is a link to `result.href`; the action text is a visual affordance inside that link, not a nested anchor.
- The client renders only fields returned by the validated response. No count, course name, timestamp, module, or description is derived from anything other than the response.

## Security considerations

- No new client-side data access: the browser still only calls `/api/search`, which runs MCP/LLM work server-side. No token, MCP endpoint, or model detail reaches the browser.
- `coverImageUrl` is a public Sanity CDN asset URL, already an allowed `next/image` remote pattern; no new host.
- New GROQ projections add one public field to existing bounded queries — no change to result caps, transcript bounds, or the Context scope.
- The response contract change is additive and still fully Zod-validated before it leaves the server.

## Acceptance criteria

1. `/search?q=data+fetching` renders the reference layout: eyebrow, serif heading with the query quoted in primary, grounded summary line, search field with `⌘ K`, toolbar, rows, CTA.
2. Video rows deep-link to `/lessons/<slug>?t=<seconds>` and their thumbnail badge and "Watch from" label both show the matched second.
3. Lesson rows link to `/lessons/<slug>` and show up to 3 stored key points, the derived module number, and no fabricated fields.
4. `courseCount` matches the number of distinct courses in the full ranked set and does not change when "Show more results" is used.
5. Missing stored values (no poster, no cover image, no key points, no module position) degrade to omission or a neutral tile — never a placeholder value.
6. Empty query, loading, error, and zero-result states all render correctly in the new layout.
7. `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` all pass.

## Checks

```
npm run typecheck
npm run lint
npm test
npm run build
```

`npm run build` is included because a server search module and the API response contract change.

## Manual tests

1. `npm run dev`, open `http://localhost:3000/search?q=data%20fetching`. Confirm the hero, summary line, toolbar count, and rows match the reference; compare against `design/vertex-search.png`.
2. Click a `VIDEO` row → lands on `/lessons/<slug>?t=<seconds>` and the embed starts at that second.
3. Click a `LESSON` row → lands on `/lessons/<slug>`.
4. Press "Show more results" → additional rows append; the "N results" count and "across M courses" stay unchanged.
5. `/search` with no query → plain "Search" heading, form, invitation copy, no toolbar or CTA.
6. `/search?q=zzzzqqq` → zero-result state with the CTA card.
7. Resize to ~375px → rows stack, nothing overflows horizontally.

`.env.local` has `SANITY_API_READ_TOKEN` and `OPENAI_API_KEY` set, so the live MCP path is testable locally provided the Studio is deployed; if the MCP is unavailable the error state is what will be verifiable, and that will be reported as such.
