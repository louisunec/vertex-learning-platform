# Lesson page

## Goal

Implement `/lessons/[slug]` per `design/vertex-lesson.png`, wired to the seeded Sanity content, with the lesson video playing on the page through the provider embed.

## Guidance read

- `AGENTS.md` (§2 invariants, §4 UI work, §8 playback, §11 stable behavior, §12 verification)
- `docs/PRODUCT.md` §5 (lesson page contents), §9 (Notes tab is a presentation of stored lesson notes)
- `docs/VIDEO_PIPELINE.md` §9–10 (provider embeds, start-time parameter, no custom player)
- `node_modules/next/dist/docs/01-app/01-getting-started/03-layouts-and-pages.md` (`params`/`searchParams` are Promises; `PageProps` helper)

## Code inspected

- `app/courses/[slug]/page.tsx` — the pattern to mirror (async params, `auth()` in parallel, `summarizeCourseProgress`, server-side PostHog capture, `notFound()`, layout shell with `SiteHeader`/`Skyline`).
- `sanity/queries/lessons.ts` + `sanity/data/lessons.ts` — `getLessonBySlug` already returns the lesson, its derived parent course (modules + lesson summaries), and `context` (module/lesson numbering) or `null`.
- `sanity/data/progress.ts` — `getProgressForUser`, `getLessonProgress` (per-request, keyed by server-resolved Clerk id).
- `lib/course-progress.ts`, `sanity/lib/curriculum.ts` — `summarizeCourseProgress`, `flattenLessons`, `findLessonContext`.
- `lib/video/provider.ts` — `parseVideoUrl` gives provider + provider-native id; no embed-URL builder exists yet.
- `components/course/course-curriculum.tsx`, `course-progress-bar.tsx`, `components/ui/*` — accordion, progress, Badge/Icon/Button/Card/Breadcrumbs patterns and design tokens to reuse.
- `next-sanity` re-exports `PortableText` — no new dependency needed for notes rendering.
- Seed data: 120 lessons with YouTube `videoUrl`, `notes` (Portable Text), `keyPoints`, `proTip`, `resources`, `durationSeconds`, `studentCountDisplay`.

## Decisions / assumptions

1. **Tabs.** *Lesson Content* = Overview (renders `notes` Portable Text) → "In this lesson you will:" checklist (`keyPoints`) → Pro Tip callout (`proTip`) → Resources (`resources`). *Notes* tab = the same stored `notes` rendered alone (PRODUCT §9: the Notes tab presents stored lesson notes; there is no separate notes field). The `notes` field appears in both tabs — flag if you want a different mapping.
2. **Start time.** `?t=<seconds>` search param wins; otherwise the signed-in learner's stored `resumeSeconds` for this lesson; otherwise start at 0. Invalid/negative values are ignored. No progress writes, no mark-complete action, and the bookmark button stays presentational (nothing in the design or request asks for a write path).
3. **Playback.** Plain provider embed iframe (no facade, no custom player). New framework-free `getEmbedSource(parsed, startSeconds?)` in `lib/video/embed.ts`: YouTube `https://www.youtube-nocookie.com/embed/{id}?rel=0[&start=N]`, Vimeo `https://player.vimeo.com/video/{id}[#t=Ns]`, Bunny `https://iframe.mediadelivery.net/embed/{lib}/{guid}[?t=N]`. Bunny's `t` param is per its embed docs; seeded content is all YouTube so only YouTube is manually verifiable now.
4. **Orphan lesson.** When no course references the lesson (`course === null`): render title/meta/video/tabs, omit sidebar, prev/next and module breadcrumb. Never fabricate course context.
5. **Breadcrumbs.** All Courses → course → module title → lesson title (derived from the real curriculum position).
6. **Sidebar course tile.** Needs the course cover image, so `LESSON_BY_SLUG_QUERY` gains `coverImage { imageFragment }` inside the derived `course` projection, followed by `npm run typegen`. No other query changes.
7. **No `video` document fetch.** The design shows no chapters; chapters/transcripts stay out of this page until search deep-linking needs them.
8. **Lesson header meta.** Duration (`durationSeconds`), level (from parent course), `studentCountDisplay` — rendered only when stored; no subtitle (no stored summary field for lessons).

## Expected files

- `prompts/lesson-page.md` — this prompt.
- `sanity/queries/lessons.ts` — add `coverImage` to the derived course projection.
- `sanity.types.ts` — regenerated via `npm run typegen`.
- `lib/video/embed.ts` + `lib/video/embed.test.ts` — embed source builder + tests (all three providers, start-second handling, invalid input).
- `components/ui/icon.tsx` — add `arrow-left` glyph (mirror of `arrow-right`).
- `components/lesson/lesson-sidebar.tsx` (client) — back-to-course link, course tile with cover + "% complete" (signed-in only), module accordion with the current module expanded, per-module durations, completed checks, "Now playing" marker on the current lesson.
- `components/lesson/video-embed.tsx` — iframe wrapper (`aspect-video`, rounded dark frame per design, `allow="autoplay; fullscreen; picture-in-picture"`, `allowFullScreen`, `title` = lesson title).
- `components/lesson/lesson-tabs.tsx` (client) — Lesson Content / Notes tabs with PostHog tab-change capture, matching existing event patterns.
- `components/lesson/lesson-notes.tsx` — `PortableText` (from `next-sanity`) renderer styled to the project's type scale.
- `components/lesson/lesson-footer-nav.tsx` — sticky Previous/Next bar with adjacent lesson titles + durations from `flattenLessons`.
- `app/lessons/[slug]/page.tsx` — server page assembling the above; `generateMetadata`; server-side PostHog `lesson_viewed` (lesson title/slug/position, course slug, start_seconds), mirroring `course_viewed`.

## Requirements

- Mirror the course page's data flow: `getLessonBySlug(slug)` + `auth()` in parallel; `notFound()` when missing; progress via `getProgressForUser` + `summarizeCourseProgress`, resume via `getLessonProgress` — all per-request, keyed by the server-resolved Clerk user id.
- Client components receive trimmed serialisable props only (as `CourseCurriculum` does), never raw query results.
- Reproduce the reference layout: left sidebar (~300px) inside the 1200px bordered canvas, main column with breadcrumbs, "LESSON x.y" label, serif title, meta row, player, tabs, content sections, sticky footer nav. Collapse the sidebar sensibly on small screens (stacked above/below content) — smallest sensible adaptation.
- Reuse `Badge`, `Icon`, `Button`, `Card`/`ResourceCard`, `Breadcrumbs`, `ProgressBar`, `formatDuration`/`formatClock`/`formatLevel`, existing Tailwind tokens.
- Render only stored values; omit any missing field's row entirely (grounding invariant).

## Security

- All Sanity access stays server-side through the existing `server-only` data layer; no tokens or write paths reach the browser.
- The embed iframe loads only provider-hosted players over https; `?t=` is parsed as a bounded non-negative integer before use.
- PostHog capture is server-side via `getPostHogClient()` with the Clerk-resolved id, as on the course page.

## Acceptance criteria

1. Visiting a seeded lesson URL (e.g. `/lessons/nextjs-app-router-in-depth-file-system-routing`) renders the design: sidebar curriculum, lesson header, playing-capable embedded video, Lesson Content/Notes tabs, key points, pro tip, resources, prev/next footer.
2. The video plays on the page via the provider embed; `?t=90` starts YouTube playback at 1:30.
3. Signed-in learners see course % complete, completed checkmarks, and "Now playing"; signed-out visitors see the page without progress affordances.
4. Prev/next navigate in authored curriculum order across module boundaries; first/last lessons drop the missing side.
5. A lesson with no referencing course renders without fabricated course context.
6. Missing optional fields (proTip, resources, duration, student count) leave no empty shells.

## Checks

- Web: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` (new route + server modules).
- Studio: `npm run typegen` after the query change.
- Manual: `npm run dev` → open a seeded lesson; play the video; reload with `?t=90`; check signed-in vs signed-out; navigate prev/next; resize to mobile width.

## Manual tests

1. `npm run dev`, open `http://localhost:3000/courses`, click into a course, click a lesson.
2. Press play — the video must play on-site.
3. Append `?t=90` to the lesson URL, press play — playback starts at 1:30.
4. Sign in, complete state visible in the sidebar; sign out, progress UI disappears.
5. Click Previous/Next through a module boundary and at both curriculum ends.
