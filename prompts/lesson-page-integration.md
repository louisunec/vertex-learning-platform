# Integrated lesson page (outline · player + activities · tutor)

Status: **approved by the user 2026-09-14 ("Yes"); implemented and committed on `feat/lesson-page-integration`.** :3000 merge owner: vertex-ff (user's choice). Written by session vertex-12; implementation notes at the end.

## Goal

Rebuild `/lessons/[slug]` to the layout of `design/vertex-lessonupdate-tutor.jpg`, using only existing
components and data:

- left: the real course outline and viewing progress (`LessonSidebar`);
- centre: the existing player (`VideoEmbed`), the existing lesson content tabs, then **learning
  activity tabs**: Quick check (PR-7), Explain it back (PR-8), Submit implementation (PR-12);
- right: the existing PR-7 `TutorPanel`, tied to the real playhead.

The PR-8 and PR-12 components, endpoints and state stay theirs. This work adds the slots they plug into.

## Adjustments to the reference (from the user)

- Keep the five confidence choices (Guessing, Unsure, Fairly sure, Sure, Certain), not the reference's three.
- No "Course outline" tab in the tutor panel.
- Real course title, durations, progress and adjacent lessons only.
- The VISUAL citation badge appears only when a validated citation has `source` `ocr` or `vlm`.
- No learner notes, bookmarks, autosave or "saved" indicators: none of them has persistence. The
  presentational bookmark button on the lesson page is removed. The course-page bookmark is out of scope.
- `VideoEmbed` and progress saving are unchanged.
- The tutor stays disabled until its gate is met. It shows an honest unavailable state with no
  sample chat, prompts or follow-up chips.

## Guidance read

- `AGENTS.md`, `CLAUDE.md`.
- Memory notes: PR-7, PR-12, knowledge map, My Learning, focused review, PR-9, PR-11, preview load,
  toolchain, live content.
- `prompts/pr-8-explain-back.md` in `../vertex-pr-8`.
- Next.js docs: read on approval, before code (`node_modules/next/dist/docs/`: server/client
  composition, passing server components as props).

## Code inspected

- **Preview `../vertex-my-learning`** (`c5d9d87`, :3000) and **PR-7 `3de183e`**:
  - `app/lessons/[slug]/page.tsx`;
  - `components/lesson/{lesson-assist,lesson-player,tutor-panel,lesson-check,drawer,use-media-query,lesson-sidebar,lesson-tabs,lesson-footer-nav,video-embed}.tsx`;
  - `lib/lesson/{features,resolve-features,citations}.ts`;
  - `lib/ai/contracts.ts` (`resolvedCitationSchema.source`);
  - `lib/evidence/chunks.ts` (`EVIDENCE_SOURCES = transcript | ocr | vlm`);
  - `sanity/queries/lessons.ts`;
  - `lib/flags.ts`.
  - Between `3de183e` and the preview, the lesson page files differ only by #14's progress queue in
    `video-embed.tsx`, plus small `badge`/`icon`/`globals.css` additions.
- **PR-12 `54ec90c`** (`../vertex-pr-12`, draft #17):
  - `resolveSubmissionTask` (flags `submission-review` + `learner-evidence` + `help-policy`, and a
    published task);
  - `SubmissionReview`, which is its own collapsible `<section>` card;
  - the `page.tsx` hunk, which adds a third `Promise.all` entry and a `features || submissionTask`
    provider ternary.
- **PR-8** (`../vertex-pr-8`, uncommitted):
  - `resolveExplainTask` (flags `explain-back` + `learner-evidence`) and `/api/explain` exist;
  - `components/lesson/explain-back.tsx` and its `page.tsx` hunk are planned but not written yet.

## Live facts (checked 2026-09-14, read-only)

- **Flags** for the course owner's dev-instance account (server `evaluateFlags`):

  | Flag | State |
  | --- | --- |
  | `lesson-integration` | on |
  | `learner-evidence` | on |
  | `help-policy` | on |
  | `tutor` | **off** |
  | `explain-back` | off |
  | `submission-review` | **on** |

  Memory said `submission-review` didn't exist and had to stay off. It now evaluates on.
- Tutor: `tutor` is off, and PR-6's pilot gate (reviewed eval cases) is not met. Correction found
  during implementation: PR-2 (`68c2f25`) **is** in `preview/my-learning`, so the citation `source`
  field exists there. It is not in `3de183e`. The tutor retrieval itself is transcript-only per PR-6.
- Content: 17 approved assessments (Practical Web Security), so Quick check is live-verifiable. The PR-12
  and PR-8 pilot tasks are local drafts only (`docs/*/…draft.ndjson`), never imported, so neither tab can
  appear live.

## Decisions (proposed, need your OK)

1. **Where.**
   - A new worktree `../vertex-lesson-page`, branch `feat/lesson-page-integration`, off PR-7 `3de183e`.
     PR-8 and PR-12 use the same base, so only `page.tsx` overlaps.
   - No work in the main checkout (dirty theme files) or in `../vertex-my-learning`.
   - Getting it onto :3000 is a separate merge into `preview/my-learning` by whoever owns :3000.
2. **Composition.**
   - New client `LessonWorkspace` owns the grid, the single breakpoint (`useMediaQuery`), the mobile
     outline disclosure and the tutor placement.
   - The server page resolves data and renders one `<LessonWorkspace>`. It passes the sidebar, header,
     video, content tabs and footer as `ReactNode` props.
   - `LessonPlayerProvider` wraps the workspace for every visitor. With no consumers it does nothing.
     This drops PR-12's `features || submissionTask` ternary.
3. **Shared open task.**
   - `activeTask`, today `useState` in `LessonAssist`, moves to a small context next to the player
     bridge (`lesson-player.tsx`). `LessonCheck` reports its open question through it; `TutorPanel` reads it.
   - Slots can then be plain server-created elements.
   - `LessonAssist` is removed.
4. **Activity slot contract** (published to PR-8/PR-12):
   ```ts
   activities: {
     quickCheck: ReactNode | null;           // PR-7 <LessonCheck …> when features.check
     explainBack: ReactNode | null;          // PR-8 <ExplainBack … embedded /> when resolveExplainTask() != null
     submitImplementation: ReactNode | null; // PR-12 <SubmissionReview … embedded /> when resolveSubmissionTask() != null
   }
   ```
   - A tab renders only when its slot is non-null. With no slots there is no activities card.
   - An unavailable activity is **hidden, not shown disabled**: there's nothing to wait for on that lesson.
   - Tab order is fixed: Quick check, Explain it back, Submit implementation. The first available tab is
     selected.
   - Panels stay mounted (`hidden`), so an open question, a draft explanation or pasted code survives a
     tab switch.
   - Tab selection reuses the existing `lesson_tab_selected` event with the tab label. There is no new
     event.
   - Each PR adds only its resolver to the page's `Promise.all` and one slot prop. Each PR adds an
     `embedded` prop to its own component, which renders the body open, without its collapsible
     `<section>` shell and toggle. **I don't edit their components.**
5. **Tutor states.**
   - `decideLessonFeatures` (pure, unit-tested) gains `tutorUnavailable: 'rollout' | 'provider' | null`.
   - `resolveLessonFeatures` returns features for any signed-in learner with `lesson-integration` on,
     even when neither feature is on. It still returns `null` when `lesson-integration` is off: then
     there's no tutor column and no Quick check.
   - Signed out: no tutor column, no activities; outline and centre only.
   - Unavailable copy, with no composer, chips or chat:
     - `rollout`: "The lesson tutor isn't switched on for your account yet."
     - `provider`: "The tutor needs a video it can follow, so it isn't available for this lesson."
6. **TutorPanel.**
   - New `layout: 'column' | 'drawer'`.
   - `column` is an always-open card, headed "Ask about this lesson". Turns come first, each showing the
     learner's own question and the playhead second actually sent ("You · at 8:42"). The existing
     composer (question, Guide me / Just explain it, Ask) sits at the bottom.
   - `drawer` is today's trigger card plus `Drawer`.
   - One instance, whose placement is decided by the workspace's breakpoint, so resizing never remounts
     it or loses turns.
   - The existing behaviour stays unchanged: hint ladder, retries, help levels, `ph-no-capture`, the
     privacy-safe analytics, and the latest question replacing earlier turns.
7. **Citations.**
   - `groupCitations` carries `source` and splits a group on a source change.
   - Chips read "Transcript · 8:12–8:20", or "Visual · 8:35" only for `ocr`/`vlm`.
   - Seeking in place is unchanged (`player.seekTo`); other lessons still link with `?t=`.
8. **Breakpoints and width.** The reference is ~1450 px wide. Today's frame is 1200 px, which would leave
   ~480 px of video with three columns.

   | Width | Layout |
   | --- | --- |
   | ≥1280 px (`xl`) | Frame widens to `max-w-[1440px]` on this page only: outline 260 · centre (video ≥ ~600 px) · tutor 360 |
   | 1024–1279 px | Outline + centre; tutor opens as the existing accessible bottom drawer (native `<dialog>`: focus trap, Escape, focus return) from a trigger under the player |
   | <1024 px | Outline collapses into a "Course outline" disclosure (course title, % complete, "Module N of M") at the top of the centre; the same `LessonSidebar` instance, so no duplicate ids; tutor drawer as above |

   The column frame renders on the server, and the panel body mounts after hydration, so the video
   never shifts. No horizontal overflow at 360 px.
9. **Restyle only, same data.**
   - Sidebar lesson rows: numbered circle, title, duration, a check-circle when completed, a play icon
     when current.
   - Footer nav becomes a card at the bottom of the centre column: Previous/Next plus neighbour title and
     duration, the same `prev`/`next` data.
   - Quick check: at `md`+, options on the left and a right rail with "How sure are you?" (all five
     chips, wrapping), Check answer and Get a hint.
   - The breadcrumb and lesson badge stay as today ("Lesson {position}"); the reference's "3.2" is not
     derivable without new logic.
   - No lesson description line: the lesson has no description field.
   - The existing content tabs (Lesson Content / Notes, where Notes means author notes) stay as they
     are, above the activities. I'm not renaming them to the reference's labels, because "Notes" there
     is a learner editor we don't have.

## Expected files (branch `feat/lesson-page-integration`)

- `app/lessons/[slug]/page.tsx`: one workspace, the bookmark removed, the frame widened at `xl`.
- `components/lesson/lesson-workspace.tsx` (new): grid, breakpoint, outline disclosure, tutor placement.
- `components/lesson/lesson-activities.tsx` (new): the activity tabs.
- `components/lesson/lesson-player.tsx`: the active-task context.
- `components/lesson/tutor-panel.tsx`: `layout`, turn echo, source badges, and the `TutorUnavailable` state.
- `components/lesson/lesson-check.tsx`: context instead of the prop, embedded framing, the two-column
  question layout.
- `components/lesson/lesson-sidebar.tsx` and `lesson-footer-nav.tsx`: restyle.
- `components/lesson/lesson-assist.tsx`: deleted.
- `lib/lesson/features.ts` and its test: `tutorUnavailable`.
- `lib/lesson/resolve-features.ts`.
- `lib/lesson/citations.ts` and its test: `source`.

Unchanged: `video-embed.tsx`, `drawer.tsx`, every API route, every schema, and the migrations.

## Security and invariants

- No new routes, credentials or client-side flag evaluation.
- Tutor, check and review calls go through the existing authenticated routes.
- Flags are evaluated on the server per learner and fail closed. Signed-out learners get no activities.
- No learner text goes to analytics.

## Acceptance criteria

1. `xl` signed in: three columns as in the reference. With `tutor` off, the right column shows only the
   honest unavailable state: no messages, chips or input.
2. The Quick check tab shows the PR-7 check with five confidence choices. Answering, hints and the
   fresh follow-up behave exactly as before.
3. Explain it back and Submit implementation appear only when their resolvers return a task. Live
   today, both are absent.
4. Playback, resume (`?t=` beats the stored position) and progress saves are unchanged.
5. With the tutor forced on in a local harness, a same-lesson citation seeks the player in place (the
   drawer closes first on narrow widths). A Visual badge appears only on an `ocr`/`vlm` citation.
6. <1024 px: the outline is collapsed behind an accessible disclosure; the tutor opens in the drawer
   (Escape closes it and focus returns); no horizontal scroll at 360 px; the video is full width.
7. Signed out: outline and centre only; no tutor column, no activities; the page returns 200.

## Checks

- `npm test`, with and without `TEST_DATABASE_URL` on an isolated embedded Postgres (never
  `vertex_local`).
- `npm run typecheck`, `npm run lint`, `npm run build`.

## Manual tests

Run on my worktree's own dev server (`next dev -p 3007`) with a copy of the preview `.env.local`. :3000
isn't touched.

1. Sign in with a one-time Clerk sign-in token for your account, and revoke the session afterwards. Open
   `/lessons/practical-web-security-sessions-vs-jwt` at 1440, 1180, 800 and 375 px. Capture screenshots
   and compare them with the reference.
2. Outline: current module expanded, completed checks and % match `/my-learning`; Previous/Next titles
   and durations match the course order; the links navigate.
3. Play for 20 s, pause, reload: "Resume at 0:2x" and embed `start=`; `?t=120` overrides it.
4. Quick check: start it, pick a confidence level, check the answer. The open question shows in the tutor
   notice only when the tutor is on.
5. Tutor off (live): the unavailable state at every width; the drawer trigger is disabled with the same
   text.
6. Citation seek. The harness uses a temporary uncommitted patch that forces `tutor` on for :3007 only.
   Playwright (installed in the scratchpad) intercepts `/api/tutor` with a fixture response: no model
   call, no DB write. Click a same-lesson chip and confirm the player time changes. Repeat with a `vlm`
   fixture citation for the Visual badge. The patch is reverted and `git diff` checked.
7. PR-12 tab: shown in a harness only, by forcing a fixture `LearnerTaskView` locally (reverted after).
   It can't appear live.

## Coordination

- **vertex-96 (PR-8, no UI written yet):** build `ExplainBack` with an `embedded` prop and add only
  `resolveExplainTask` plus the `explainBack` slot to the page; no provider ternary, no `LessonAssist`.
- **vertex-c8 (PR-12):** add `embedded` to `SubmissionReview`; after rebasing onto this branch, replace
  its page hunk with the resolver plus the `submitImplementation` slot.
- **vertex-ff:** owns `preview/my-learning` and :3000 per the memory notes. There's an uncommitted
  `evidence-panel.tsx` edit there. Who merges this into the preview is your call (question 2).

## Implementation notes (2026-09-14)

The worktree is `../vertex-lesson-page`, branch `feat/lesson-page-integration` off `3de183e`. It is uncommitted, not pushed, and not merged into the preview.

**Deviations from the plan**

- **Citation source.** `resolvedCitationSchema.source` comes from PR-2 (`68c2f25`), which is in `preview/my-learning` but not in `3de183e`.
  - `lib/lesson/citations.ts` declares `SourcedCitation = ResolvedCitation & {source?}`, so it compiles on both stacks.
  - On this branch every citation is a transcript citation. On the preview, `ocr`/`vlm` citations show "Visual".
- **Tutor placement.** One `TutorPanel` sits at a fixed position in the tree, and CSS grid places it: a sticky right column at ≥1280 px, or under the video below that.
  - Only its `layout` prop changes, so the conversation survives a resize. This replaces the plan's "column frame on the server, body after hydration".
  - The server renders `layout="drawer"`. Desktop switches to `column` on hydration, inside the tutor's own grid cell, so the video never shifts.
- **Composer cleared after a successful answer.** The question now appears in the turn as "You · at m:ss", so leaving it in the box would duplicate it. The text is kept after a failure, and retries resend the stored call.
- **Frame width and breakpoints.**
  - Tutor column: `clamp(340px, 27vw, 390px)`.
  - Video width measured: 725 px at 1440, 838 px at 1180 (no tutor column), 325 px at 375.
- **The unavailable tutor below 1280 px is a static card, not a disabled button.** It shows the same heading and reason and nothing to focus.
- **Footer.** The previous/next card is no longer sticky. It sits at the foot of the centre column, as in the reference.
- **Activity panels carry `ph-no-capture`** (on the tabpanel wrapper), so every slot is excluded from replay, whatever it renders.
- **`<main>`** now wraps the whole workspace, including the outline `aside`, because the centre is no longer one element.

**Verification**

- Typecheck, lint and build pass (after clearing a stale `.next/dev/types/validator.ts` left by a killed dev server).
- Tests:

  | Run | Result |
  | --- | --- |
  | Without `TEST_DATABASE_URL` | 476/476 |
  | With it (embedded PG :54340 in the session scratchpad; the DB suites use DB `vertex_test`, the :3007 app used `vertex_lessonpage`, migrations 0001–0002) | 568/568 |

- **Signed out on :3007, live data, all four widths:**
  - 200;
  - no tutor column and no activities;
  - no bookmark;
  - real neighbours in the footer;
  - outline collapsed below 1024 px;
  - no horizontal overflow at 1440, 1180, 800 or 375 px.
- **Harness on :3007.** This was a temporary patch to `page.tsx` that set `userId = "harness"` and fixed the flags, with placeholders in the PR-8 and PR-12 slots. It was reverted: the sha matches the backup, and no harness code remains.
  - Playwright answered `/api/lesson-check`, `/api/tutor` and `/api/progress` with fixtures. No session was used, no model was called, and nothing was written to the DB or Sanity.
  - **Tutor off:** at every width the tutor shows "Not available yet / The lesson tutor isn't switched on for your account yet." with no input.
  - **Quick check:** all five confidence choices appear. The chosen answer and a PR-12 slot draft both survive tab switches, and the arrow keys move between tabs.
  - **Tutor on:**
    - it's a column at 1440 and a drawer at 1180 and 375;
    - the check question's task goes with the question;
    - chips read "Transcript 2:00–2:10" and "Visual 3:20–3:25" (the `vlm` fixture);
    - the transcript chip seeks in place (URL unchanged) and closes the drawer;
    - direct proof of the seek: play was never clicked in this run, yet after the 2:00 chip the player
      posted progress saves at ~135 s (the 15 s interval after 120 s) and on pause, at ~139–141 s.
  - The tutor column is sticky: it sits at top 133 px, then 36 px after scrolling 1200 px.

**Not verified**

- **Real signed-in flows:** your account, real `/api/lesson-check`, the attempt and help calls, resume after reload, and the outline percentage against `/my-learning`. Creating a Clerk sign-in token was blocked by the permission classifier.
- Escape and focus return in the drawer weren't re-tested. `drawer.tsx` (native `<dialog>`) is unchanged.
- Real PR-8 and PR-12 components in their tabs: the branch has placeholders only.

**Follow-up (user decisions, 2026-09-14)**

- **Module titles in the outline.** They wrap to their full length instead of truncating. Each row grows with its title, the module number and chevron stay vertically centred, and the chevron keeps a fixed 24 px right inset.
  - Measured with live data at 1440, 1180, 800, 375 and 320 px: no title clipped. Two-line rows are 90 px at 1440 and 1180 px; rows are one line at 800 px and below.
  - At 320 px the only horizontal overflow is the shared site header's Sign in button (358 px). It is pre-existing and also on :3000, so it isn't from this page.
- **`submission-review` flag.** It wasn't changed. The available PostHog credentials are a `phc_` project token and a `phs_` flag-evaluation key, and changing a flag needs a personal API key (`phx_`). The user changes it in PostHog. `tutor` stays off.
- **Signed-in testing.** Every signed-in check on this branch used stubbed learner APIs: a fake user id, fixture responses from Playwright, and no session. Real signed-in flows are verified only after the :3000 integration, with the user signing in normally in the verification browser.
