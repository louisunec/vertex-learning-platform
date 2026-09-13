# My Learning — integration fixes (navigation, dark theme, real data states)

Worktree `../vertex-my-learning`, branch `feat/my-learning-overview` (uncommitted). No new page and no branch change.

## Findings (investigated 2026-09-13)

| Area | Finding |
| --- | --- |
| Navigation | Header "My Learning" → `/my-learning` returns 200 from this worktree. The earlier 404 came from the server running in `~/Downloads/vertex` (`feat/pr-3-concepts` has no route). `NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=/`, so a sign-in without an explicit redirect can land on `/`. |
| Theme | The black/mint + Geist theme exists only as uncommitted edits in `~/Downloads/vertex` (`prompts/jsmastery-dark-theme.md`). Excluding the unrelated `@supabase/*` lines in `package.json`/`package-lock.json`, the 21-file theme patch applies cleanly here (`git apply --check`). |
| Overflow | Signed out: none from 768–1440 px. At 390 px the page is 453 px wide because the existing header's Sign in + Sign up buttons don't wrap (same on `/courses`). The signed-in layout isn't measured yet (needs a session). |
| Progress | The read path exists (`PROGRESS_FOR_USER_QUERY`), but **nothing writes progress**: `video-embed.tsx` says "no progress write path exists yet". Production has **0** `progress` documents, so every learner currently looks new. The dataset is private (unauthenticated reads return nothing). |
| Evidence | `DATABASE_URL` is unset in every worktree. The `learner-evidence` flag state per user is unknown (PostHog). Production has **0** concepts and **0** assessments. |
| Failures | `getProgressForUser` throwing currently crashes the page. Evidence and concept failures are caught and **hidden**, which turns a failure into an empty state (must change). |

## Card audit (live, before changes)

| Card | Source | Status today |
| --- | --- | --- |
| Current goal | none (PR-11) | not implemented |
| Recommended next | none (PR-11) | not implemented |
| Due for review | none (PR-9) | not implemented |
| Practice | none (PR-7) | not implemented; missing content (0 approved assessments) |
| Continue learning | Sanity `progress` | implemented; no learner activity for every learner (no write path) |
| My courses | Sanity `progress` + courses | implemented; no learner activity (same cause) |
| Concepts with evidence | Postgres `concept_mastery` + concepts | implemented; not configured (`DATABASE_URL` unset); flag unverified; missing content (0 concepts) |
| Recent learning | Sanity `progress` + Postgres `attempt_log` | implemented; progress part has no activity; practice part is not configured |

## Plan

### 1. Navigation
- Sign-in CTA on `/my-learning`: `SignInButton mode="modal" forceRedirectUrl="/my-learning" signUpForceRedirectUrl="/my-learning"`.
- Verify: the header link lands on `/my-learning` (active state), and a real modal sign-in from `/my-learning` returns to `/my-learning`.

### 2. Theme, typography, responsive
- Apply the 21-file theme patch as uncommitted edits here, and copy `prompts/jsmastery-dark-theme.md`. `~/Downloads/vertex` and the shared stash are not touched.
- Adapt the My Learning components to dark tokens. The neutral tile (`bg-neutral-100` equals the surface in dark) becomes `bg-neutral-200/50`. `font-display` becomes Geist, giving the sans-serif title.
- Measure `scrollWidth` at 1440/1280/1024/768/390, signed out and signed in (both learners). Fix every My Learning offender. For the shared header at < 450 px: hide the secondary "Sign up" button below `sm` (the sign-in modal links to sign-up).

### 3. Explicit data states (no failure shown as empty)
- The page reads sources with `Promise.allSettled`. A pure `lib/my-learning.ts` derivation maps each card to one of:
  `ready | no_activity | missing_content | flag_disabled | not_configured | error`.
- Evidence: flag off → `flag_disabled` (nothing shown). Flag on without `DATABASE_URL` → `not_configured`. Read or concept failure → `error`. Only `error` and `not_configured` show a visible "couldn't load" notice. Every failure is also logged server-side.
- Progress or course failure → Continue/My courses/Recent learning show "We couldn't load your learning activity. Refresh to try again." "Browse courses" still works.

### 4. Layout for unavailable features
- Replace the Goal and Recommended cards and the three tiles with:
  1. **One primary next-step card** (full width).
     - With progress: "Continue learning", showing the lesson title, course, and "Resume at m:ss", plus a mint **Continue lesson** button.
     - New learner: "Start learning" and a mint **Browse courses** button.
     - Error: the error notice and **Browse courses**.
  2. **A compact, low-emphasis "Coming soon" row**: Learning goals · Recommendations · Reviews · Practice. Small muted text only: no icon cards, no chevrons, no links.
- Keep My courses + Recent learning as designed. No invented progress, goals or recommendations.

### 5. Real learner data (depends on the decision below)
- **A (recommended): add the progress write path.**
  - `POST /api/progress {lessonId, positionSeconds, completed?}`: Clerk `auth()` required, bounded JSON, Zod schema, and the published lesson must exist. Position is clamped to `[0, durationSeconds]`. `completed` is never unset.
  - Deterministic doc id `progress-<sha256(userId)[:24]>-<lessonId>`, written via `createIfNotExists` + `patch`.
  - Server-only write client with a new `SANITY_API_WRITE_TOKEN` (**not** the read token). Added to `.env.example`.
  - `video-embed.tsx` (YouTube only; other providers are play-only) saves on pause, every 15 s while playing, at the existing 90 % completion milestone, on end, and on `pagehide` (`keepalive` fetch).
  - Tests: unauthenticated → 401, unknown lesson → 404, invalid body → 400, clamping, completion never reverts, repeat writes update one document.
- **B:** no writer. Copy production to a temporary dataset, add progress for a test user there, verify against it, then delete the dataset.
- **C:** no writer. The saved-progress learner is covered by unit tests only.

## Files
- Theme patch (21 files) + `prompts/jsmastery-dark-theme.md`.
- `app/my-learning/page.tsx`, `lib/my-learning.ts` (+ tests).
- `components/my-learning/{next-step-card,coming-soon,card-parts,my-courses-card,recent-learning-card}.tsx`. `quick-tile.tsx` and `next-step-cards.tsx` are removed.
- `components/home/site-header.tsx` (responsive Sign up).
- A only: `app/api/progress/route.ts`, `lib/progress/{write,contracts}.ts` (+ tests), `sanity/lib/write-client.ts`, `components/lesson/video-embed.tsx`, `.env.example`.

## Security
- Clerk id comes only from `auth()`. The write token is server-only and never reaches the browser. No client-side Sanity writes.
- Progress docs live in a private dataset. No new PostHog events.

## Verification
- `npm run typecheck`, `npm run lint`, `npm test` (with `TEST_DATABASE_URL`), `npm run build`.
- Live, on the dev server at :3000, with two throwaway users in the **Clerk test instance**, deleted afterwards:
  1. **New learner:** "Start learning → Browse courses", My courses/Recent learning in `no_activity`, no errors. Screenshots at desktop and 390 px.
  2. **Saved progress (A):** the signed-in learner saves a position (e.g. 522 s) on one lesson and completes another through `/api/progress`. Then `/my-learning` shows Continue → "Resume at 8:42", My courses 1/N, and Recent learning rows. The lesson link resumes at 8:42. The test user's progress docs are deleted afterwards.
  3. **Query failure:** a temporary dev server on another port with an invalid Sanity read token shows the error states, not empty states.
  4. `scrollWidth == clientWidth` at every measured width for both learners.

## Implementation notes

- The write token is `SANITY_API_PROGRESS_WRITE_TOKEN`, not `SANITY_API_WRITE_TOKEN`. `.env.example` documents the latter as offline-tooling only ("never read by the app"), and DATA_MODEL §16 keeps offline write credentials out of the app.
- The header's own Sign in / Sign up on `/my-learning` also returned to `/` (the fallback env). `SiteHeader` gained a `returnTo` prop, and only My Learning passes it.
- `progress.lesson` stays a strong reference, matching the schema (user decision). Once a learner has progress on a lesson, that lesson can't be deleted in Studio.

## Rollback
- Revert the worktree files. For A: delete `/api/progress` and remove the token. Stored progress docs are additive.
