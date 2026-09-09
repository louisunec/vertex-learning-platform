# All Courses catalogue page

## Goal

Add the learner-facing catalogue at `/courses` listing every published course from Sanity,
so the home page's "Explore Courses" / "View all courses" links resolve. Keep it simple.

## Guidance read

- `AGENTS.md` §2, §3, §4, §11, §12
- `docs/PRODUCT.md` §3 (catalog surfaces stored fields only), §12
- `node_modules/next/dist/docs/01-app/01-getting-started/06-fetching-data.md`

## Code inspected

- `app/page.tsx` — catalogue section (heading, grid, card mapping) to reuse
- `app/courses/[slug]/page.tsx` — page frame and `metadata` pattern
- `components/home/site-header.tsx` (nav already links `/courses`), `components/home/skyline.tsx`
- `components/ui/card.tsx` (`CourseCard`), `components/home/course-cover-tile.tsx`
- `sanity/data/courses.ts` → `getCourses()`; `lib/format.ts`

## Decisions / assumptions

1. No design mock exists for the catalogue; it reuses the home catalogue section's
   heading and 3-column stacked-card grid verbatim.
2. Course → card mapping (cover tile, grounded labels, `href`) is extracted into
   `components/course/course-catalog-card.tsx` and shared by home and `/courses`.
3. All published courses render in `COURSES_QUERY` order (`popular desc, title asc`).
   No filters, search, pagination, or breadcrumbs — 10 courses fit one grid; the existing
   `Pagination` component can be added later if the catalogue grows.
4. Empty dataset → "No courses published yet."
5. Approved in-session after the plan was presented.

## Expected files

- `prompts/all-courses-page.md`
- `app/courses/page.tsx` (new)
- `components/course/course-catalog-card.tsx` (new)
- `app/page.tsx` (use the shared card)

## Security

Server Component reads through the server-only Sanity client; no tokens or raw results
reach the browser. No writes. Browsing stays public.

## Acceptance criteria

- `/courses` returns 200 and lists all 10 seeded courses with grounded meta; each card
  links to `/courses/<slug>`.
- `/` is visually unchanged (still three cards).

## Checks

- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`
- Running dev server: `/courses`, `/`, `/courses/<slug>` all 200.

## Manual tests

1. Open `/`, click "View all courses" → `/courses` shows 10 cards.
2. Click any card → matching course page.
