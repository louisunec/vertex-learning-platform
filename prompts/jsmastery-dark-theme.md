# Re-theme Vertex to the jsmastery.com AI-course dark theme

## Goal

Replace the current light theme (cream canvas, orange primary, Inter + Playfair Display) with the
visual theme of https://jsmastery.com/waitlist/ai-course: near-black surfaces, mint accent
`#31FBB8`, Geist Sans typography. Palette and typography only — no JS Mastery logos, copy, or assets.

## Guidance read

- `AGENTS.md` (UI work, verification), `node_modules/next/dist/docs/01-app/01-getting-started/13-fonts.md`.
- Reference site HTML + CSS (arbitrary Tailwind colors, font variables, radius frequency).

## Code inspected

- `app/globals.css` — all colors come from `@theme` tokens (`primary-*`, `neutral-*`, `canvas`, `lesson`, `success`).
- `app/layout.tsx` — Inter (`--font-inter`) + Playfair (`--font-playfair`) via `next/font/google`.
- Token usage: `text-neutral-900` 78, `text-neutral-500` 52, `text-neutral-700` 37, `border-neutral-200` 31,
  `text-primary-500` 33, `bg-white` 24, `bg-neutral-900` 9. No `dark:` variants anywhere.

## Decision

Token-level remap (inverted neutral scale) in `globals.css`, plus explicit fixes where inversion flips
meaning. Chosen over a semantic-token rename because it touches far fewer files and rolls back by
reverting commits.

| Token | Old | New |
|---|---|---|
| `canvas` | `#faf6f4` | `#0D0E11` |
| `neutral-50 / 100` | `#fafafc` / `#f1f5f9` | `#101115` / `#16171B` |
| `neutral-200 / 300` | `#e2e8f0` / `#cbd5e1` | `#2E3238` / `#51555C` |
| `neutral-400` (new; was undefined) | — | `#62748E` |
| `neutral-500` | `#64748b` | `#9EAABF` (AA on dark; reference `#62748E` is ~3.8:1) |
| `neutral-700 / 900` | `#334155` / `#0f172a` | `#CAD5E2` / `#EDEDED` |
| `primary-500 / 600` | `#f97316` / `#ea580c` | `#31FBB8` / `#81FFB6` |
| `primary-100 / 200 / 300` | light orange | mint at 10% / 18% / 35% alpha |
| `primary-400` | `#fb923c` | mint at 60% alpha (rings/borders) |
| `success` / `lesson` / `lesson-bg` | green / violet | `#4ADE80` / `#C4B5FD` / violet at 14% alpha |
| new `surface` | — | `#16171B` (replaces `bg-white` card surfaces) |
| new `on-primary` | — | `#0D0E11` (text on mint) |
| Fonts | Inter + Playfair | Geist (`--font-sans` and `--font-display`) |

## Expected files

- `app/globals.css`, `app/layout.tsx`
- `bg-white` → `bg-surface`: `components/ui/{card,input,button}.tsx`, `components/home/hero-search-form.tsx`,
  `app/search/page.tsx`, `app/lessons/[slug]/page.tsx`, `components/course/{course-progress-bar,learning-outcomes,course-curriculum}.tsx`,
  `components/lesson/{lesson-footer-nav,lesson-sidebar}.tsx`, `components/search/search-results.tsx`
- `bg-neutral-900` media placeholders → `bg-black`: `course-cover-tile`, `course-hero`, `video-embed`,
  `lessons/[slug]/page`, `lesson-sidebar`, `video-result-card`
- `text-white` on mint → `text-on-primary`: `components/ui/button.tsx`, `components/lesson/lesson-sidebar.tsx`
- Contextual fixes: `components/search/{video-result-card,lesson-result-card}.tsx`, `components/ui/icon.tsx`,
  `app/design-system/page.tsx`
- Clerk: `appearance.variables` on `ClerkProvider` (no new dependency)

## Requirements

- `color-scheme: dark` on `html`; dark `bg-hatch`; shadow tokens re-tuned for dark backgrounds.
- Display/H1 tokens get negative letter-spacing matching the reference.
- No layout, spacing, copy, or behavior changes. Studio workspace untouched.

## Security

Styling only. No env vars, routes, or data access touched.

## Acceptance criteria

- Every page renders dark with mint accents; no white card surfaces or unreadable text on mint.
- Clerk sign-in/sign-up/user menu render dark.
- `tsc`, lint, and `next build` pass.

## Checks

- `npx tsc --noEmit`, `npm run lint`, `npm run build`.

## Manual tests

1. `npm run dev`, open `/`, `/courses`, a course, a lesson (video + sidebar), `/search?q=...`, `/sign-in`, `/design-system`.
2. Confirm primary buttons show dark text on mint, cards are `#16171B` with `#2E3238` borders, video thumbnails sit on black.
3. Spot-check contrast of `neutral-900`, `neutral-700`, `neutral-500` text on `canvas` and `surface`.

## Notes

- `design/*.png` mockups become stale relative to this theme.
