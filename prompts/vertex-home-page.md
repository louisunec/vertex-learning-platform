# Vertex home page UI

## Goal

Implement the learner-facing home page at `/` from the reference `design/vertex-home.png`, using the existing Vertex design-system tokens and `components/ui` kit. Presentational only — no data fetching, no search wiring, no client JS.

## Guidance read

- `AGENTS.md` (§3 how to work, §4 UI work, §11 stable product behavior, §12 verification)
- `design/vertex-home.png` (source of truth) and `design/vertex-designsystem.png`
- `node_modules/next/dist/docs/01-app/01-getting-started/14-metadata-and-og-images.md`, `12-images.md`

## Code inspected

- `app/layout.tsx`, `app/globals.css` (Tailwind v4 `@theme` tokens: primary/neutral palette, radius, shadows, type scale, `font-display` = Playfair, `font-sans` = Inter)
- `app/page.tsx` — currently the **design-system showcase**, not a home page
- `components/ui/*` — `Logo`, `Navbar`, `Button`, `Input`, `Icon`, `Card`/`CourseCard`, `Badge`
- `lib/cn.ts`

## Decisions / assumptions

1. **Move, don't overwrite.** The showcase at `app/page.tsx` is uncommitted work; it moves to `app/design-system/page.tsx` (own `metadata`) and `/` becomes the home page. Root layout metadata switches to the product.
2. **Extend `CourseCard`** with `layout?: "row" | "stacked"`. Default `row` output is unchanged (no `/design-system` regression). `stacked` matches the mock: large icon tile on top, serif title, description, bottom divider + meta row.
3. **Extend the icon set** with `star` and `arrow-right` (mock uses an arrow, not a chevron, and a star in the footer note). Follows the existing glyph pattern.
4. **Header** composes the existing `Navbar` with a right-side bell + avatar. No route is active on home (mock shows both links in neutral-900).
5. **Avatar**: no photo asset exists → neutral placeholder (user icon in a circle). Never a fabricated photo or external image fetch.
6. **Course logos** (Next.js "N", Docker whale, TypeScript "TS"): inline SVGs in `components/home/course-logos.tsx`.
7. **Static sample content**: the three courses in the mock are hard-coded presentational data on the page (no Sanity yet). This is UI only; it does not invent a data source.
8. **Hrefs**: `/courses`, `/my-learning` — routes are not created (out of scope).
9. **Search input, ⌘K, bell**: presentational per AGENTS.md §11.
10. **Scale**: mock is ~1024px wide and reads as ~1.25× smaller than the desktop target; sizes are snapped to DS tokens where near and arbitrary values used where the mock clearly exceeds the scale (hero heading, hero search height).
11. **Decorative chrome**: hatched page margins, framed content column, orange bar-gradient footer skyline reproduced with CSS only.
12. **Responsive**: smallest sensible adaptation — 3 → 1 card columns below `lg` (3 columns at 768px collided in the meta row), hero type/search step down, notification bell hidden below `sm` so the header fits a 360px viewport without horizontal overflow.
13. **`Button` gets an `href` prop** that renders a Next `Link` with button styling — the hero CTA is a navigation, and nesting `<button>` inside `<a>` is invalid HTML.
14. **`Navbar` spacing** tightened below `sm` (`gap-5`/`gap-4`) with `whitespace-nowrap` links; desktop output unchanged.

## Expected files

- `app/page.tsx` (new home page)
- `app/design-system/page.tsx` (moved showcase + metadata)
- `app/layout.tsx` (metadata copy)
- `app/globals.css` (hatch pattern utility if needed)
- `components/ui/icon.tsx` (+ `star`, `arrow-right`)
- `components/ui/card.tsx` (`CourseCard` `layout` prop)
- `components/ui/button.tsx` (`href` prop)
- `components/ui/navigation.tsx` (mobile gaps, nowrap links)
- `components/home/course-logos.tsx`
- `components/home/site-header.tsx`

## Security

No credentials, no client-side data access, no external network calls. Server Component only.

## Acceptance criteria

- `/` visually matches `design/vertex-home.png` at desktop width: header, pill, headline, subtitle, CTA, hero search, divider, All Courses header + 3 cards, footer note, orange skyline.
- `/design-system` still renders identically.
- No client components introduced.

## Checks

- `npx tsc --noEmit`
- `npm run lint`
- `npm run build`
- Headless Chrome (CDP-emulated viewports at 360/390/768/1024/1440) screenshots of `/` and `/design-system` compared against the mock; `document.documentElement.scrollWidth === clientWidth` at every width.

## Manual tests

1. `npm run dev`, open `http://localhost:3000/` — compare with `design/vertex-home.png`.
2. Open `http://localhost:3000/design-system` — showcase unchanged.
3. Resize to < 768px — cards stack to one column, headline remains legible.
