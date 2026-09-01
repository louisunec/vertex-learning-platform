# Course detail page

## Goal

Implement the learner-facing course page at `/courses/[slug]` from the reference
`design/vertex-course.png`, rendering the seeded Sanity content through the existing
server-side data layer. Desktop fidelity to the mock, smallest sensible responsive
adaptation below it.

## Guidance read

- `AGENTS.md` §2 (invariants), §3, §4 (UI work), §7 (content model), §11 (stable product
  behavior), §12 (verification)
- `docs/PRODUCT.md` §4 (course detail), §8 (progress), §12 (UI fidelity), §13 (grounding)
- `docs/DATA_MODEL.md` §2, §8, §10, §14
- `design/vertex-course.png` (source of truth), `design/vertex-designsystem.png`
- `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md`
  (`PageProps<'/courses/[slug]'>`, async `params`), `dynamic-routes.md`,
  `01-getting-started/12-images.md` (`images.remotePatterns`), `06-fetching-data.md`

## Code inspected

- `app/page.tsx`, `components/home/site-header.tsx` — page frame (`bg-hatch`, 1200px
  bordered column, skyline), header to reuse as-is
- `components/ui/*` — `Badge` (`popular`), `Breadcrumbs`, `Button` (`href`), `Card`,
  `Icon`/`IconName`, `ProgressBar`
- `sanity/data/courses.ts` → `getCourseBySlug`, `sanity/queries/courses.ts`
  (`COURSE_BY_SLUG_QUERY`), generated `COURSE_BY_SLUG_QUERY_RESULT` in `sanity.types.ts`
- `sanity/data/progress.ts` → `getProgressForUser(userId)`, `sanity/lib/curriculum.ts`
  (`flattenLessons`, `countLessons`), `sanity/lib/image.ts` (`urlFor`)
- `proxy.ts` (Clerk middleware is active, so `auth()` works in Server Components)
- Live dataset: 10 courses × 4 modules × 3 lessons, every lesson has `durationSeconds`
  and every course a `coverImage`; 0 `progress` documents. `learningOutcomes[].icon`
  values in the seed: `grid`, `target`, `chart`, `star`, `document`, `lock` — all exist
  in `IconName`.

## Decisions / assumptions

1. **No query, schema, or TypeGen changes.** `COURSE_BY_SLUG_QUERY` already returns the
   course header fields, learning outcomes, ordered modules with lesson `durationSeconds`,
   `moduleCount`, `lessonCount` and summed `durationSeconds`. Studio workspace untouched.
2. **Route**: `app/courses/[slug]/page.tsx`, async Server Component, `notFound()` when the
   slug does not resolve. `generateMetadata` uses the stored title/summary. No
   `generateStaticParams`: the page reads Clerk `auth()` for progress, so it is dynamic
   regardless; content reads still go through `sanityFetch` (60s revalidation + tags).
3. **Mock wins over PRODUCT.md §4 on the instructor.** §4 says the course page presents the
   instructor; the mock has no instructor block. Per AGENTS §4 the mock is reproduced and
   the instructor is not rendered. Flagged in the completion report (DATA_MODEL §14).
4. **Grounded labels only.** Level is the stored enum capitalized; duration is derived from
   the summed lesson seconds (`18h 24m` / `45m`); module count from `moduleCount`;
   `studentCountDisplay` is shown verbatim (the mock's "2.1k students" is sample copy —
   the stored string is "18,240 students"). Nullable fields are omitted, never faked
   (no "0m", no placeholder counts).
5. **Curriculum** = one Client Component (`CourseCurriculum`) with `useState` for the
   expanded module and a "Show all N modules" toggle. It receives trimmed props (module
   title/summary/duration, lesson title/slug/duration/freePreview), not the raw query
   result with poster assets. The first 6 modules are visible by default; the "Show all"
   button renders only when modules are hidden (seed courses have 4, so it does not
   appear for them). Expanding a module lists its lessons, numbered `N.M` from array order
   via `flattenLessons`, linking to `/lessons/[slug]` (route not built yet — same
   convention as home linking `/courses`).
6. **Progress** (PRODUCT §8): when signed in, `getProgressForUser(userId)` rows are
   intersected with this course's lesson ids. Percent = completed ÷ resolvable lessons.
   Resume target = most recently updated incomplete lesson with progress → first
   incomplete lesson → first lesson. CTA reads "Continue Learning" when any progress
   exists for the course, otherwise "Start Learning". The bottom "Your Progress" bar
   renders only for signed-in learners (signed-out learners have no progress to show).
7. **Bookmark** is presentational (no backend requested — PRODUCT §9 pattern).
8. **Cover image**: `next/image` via `urlFor(...).width(560).height(560).fit('crop')`
   honoring hotspot, `lqip` blur placeholder; `images.remotePatterns` for
   `cdn.sanity.io/images/<projectId>/<dataset>/**` added to `next.config.ts`.
9. **Icons**: add a `users` glyph (students meta). Outcome icons map through `IconName`
   with a `check-circle` fallback for unknown values.
10. **Helpers**: `lib/format.ts` (`formatDuration`, `formatLevel`) with a `node:test` file
    following `lib/video/provider.test.ts`.
11. **No PostHog** — not installed in the project yet; course-view analytics is out of scope.
12. **Approval gate**: this session is non-interactive (the user cannot answer the Yes/No
    panel), so the prompt is recorded and implementation proceeds; noted in the report.

## Expected files

- `prompts/course-page.md`
- `app/courses/[slug]/page.tsx`
- `components/course/course-hero.tsx`, `learning-outcomes.tsx`, `course-curriculum.tsx`
  (client), `course-progress-bar.tsx`
- `components/ui/icon.tsx` (+ `users`)
- `lib/format.ts`, `lib/format.test.ts`
- `next.config.ts` (`images.remotePatterns`)

## Security

Sanity reads stay in Server Components through the server-only client. Progress is read
with the Clerk user id from `auth()` on the server, never from the browser. No client
component receives tokens or the raw query result. No writes.

## Acceptance criteria

- `/courses/nextjs-app-router-in-depth` renders header, breadcrumb, cover, badge, title,
  summary, meta row, CTAs, "What you'll learn" 2×2 grid, "Course Content" list with
  module numbers/durations/chevrons, and (signed in) the progress bar — matching the mock
  at 1200px.
- Unknown slug → 404.
- All numbers on the page are derived from stored data.
- No horizontal overflow at 360px.

## Checks

- `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run build`
- `npm run dev` → compare `/courses/nextjs-app-router-in-depth` with the mock; check
  `/courses/does-not-exist` returns 404.

## Manual tests

1. Open `/courses/nextjs-app-router-in-depth`; expand a module — lessons list with `1.1`
   style numbers and durations.
2. Sign in — the bottom progress bar appears at `0% complete` and the CTA reads
   "Start Learning" (no progress documents exist yet).
3. Open `/courses/python-for-data-work` — different cover, outcomes, and module totals.
