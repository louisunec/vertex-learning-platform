# Home page: fetch catalogue courses from Sanity

## Goal

Replace the hard-coded "All Courses" sample cards on the home page with courses read
from the seeded Sanity dataset through the existing server-side data layer, keeping the
`design/vertex-home.png` layout.

## Guidance read

- `AGENTS.md` §2 (invariants), §3, §4 (UI work), §7 (content model), §11, §12
- `docs/PRODUCT.md` §3 (catalog fields), §12 (UI fidelity), §13 (grounding)
- `node_modules/next/dist/docs/01-app/01-getting-started/06-fetching-data.md`
  (async Server Components), `12-images.md` (`remotePatterns`, `fill`)

## Code inspected

- `app/page.tsx` — static `courses` array + `course-logos` SVG tiles (only importer of
  `components/home/course-logos.tsx`)
- `components/ui/card.tsx` → `CourseCard` (`icon: ReactNode`, `level/duration/modules`
  strings, `stacked` layout); also used by `app/design-system/page.tsx`
- `sanity/data/courses.ts` → `getCourses()` / `COURSES_QUERY` (`popular desc, title asc`)
  with `courseCardFragment` (`slug`, `summary`, `level`, `coverImage`, `moduleCount`,
  `durationSeconds`); generated `COURSES_QUERY_RESULT`
- `components/course/course-hero.tsx` — existing `urlFor(...).fit("crop")` + `lqip` pattern
- `lib/format.ts` (`formatLevel`, `formatDuration`, `pluralize`), `next.config.ts`
  (`cdn.sanity.io` remote pattern already present)
- Live dataset (read-only check): 10 courses, all with a cover asset, 4 modules each,
  summed lesson durations present. First three in query order: Building AI Apps with
  LLMs, Next.js App Router in Depth, Python for Data Work.

## Decisions / assumptions

1. **No query, schema, or TypeGen changes.** Reuse `getCourses()` and slice the first
   three server-side (`HOME_COURSE_LIMIT = 3`): the mock shows three cards and "View all
   courses" implies a subset. The 10-course payload is small; a dedicated `[0...3]` query
   would need a TypeGen run for no real gain.
2. **Cover image tile, not brand logos.** The schema has no logo field; the mock's logos
   are sample art. The 72×72 tile renders `coverImage` cropped square through `next/image`
   (`urlFor(...).width(144).height(144).fit("crop").auto("format")`, hotspot-aware, `lqip`
   blur). Missing asset → neutral empty tile; no invented artwork.
3. **Grounded labels only.** `formatLevel(level)`; duration and module count are shown only
   when stored values exist. `CourseCard.duration` / `.modules` become optional and the
   meta row omits missing items — backward compatible with the design-system page.
4. **Cards link to `/courses/[slug]`** via a new optional `href` on `CourseCard` (title is a
   stretched `Link` covering the card).
5. `course-hero.tsx` is left untouched; the tile lives in a small home-only component.
6. `components/home/course-logos.tsx` is deleted (dead after this change).
7. Empty dataset renders a short "No courses published yet." line, never placeholder cards.
8. Home becomes an async Server Component; caching is the existing `sanityFetch`
   behaviour (60 s revalidate + `sanity:*` tags).
9. Approved by the user in-session ("approve your plan") after the plan was presented.

## Expected files

- `prompts/home-courses.md`
- `app/page.tsx`
- `components/home/course-cover-tile.tsx` (new)
- `components/ui/card.tsx` (`CourseCard`: optional `duration`/`modules`, `href`)
- `components/home/course-logos.tsx` (deleted)

## Security

Reads stay in a Server Component through the server-only Sanity client; no tokens or raw
query results reach the browser. No writes.

## Acceptance criteria

- `/` shows three cards from Sanity in `COURSES_QUERY` order with cover tile, title,
  summary, level, duration, module count; each links to its course page.
- No numbers or labels on the cards are invented.
- `/design-system` still renders the sample `CourseCard` unchanged.
- No horizontal overflow at 360px.

## Checks

- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`
- `npm run dev` → compare `/` with `design/vertex-home.png` at 1200px; click a card.

## Manual tests

1. Open `/`; the three cards read Building AI Apps with LLMs, Next.js App Router in Depth,
   Python for Data Work with `Intermediate · 2h 27m · 4 modules` style meta.
2. Click a card → `/courses/<slug>` opens the matching course.
3. Open `/design-system`; the Course Card sample still renders with its "N" tile.
