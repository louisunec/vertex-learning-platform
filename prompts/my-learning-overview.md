# My Learning — Overview dashboard (`/my-learning`)

## Goal

Build the My Learning Overview page from `design/vertex-mylearning.jpg`, backed only by learner data
that exists today: Sanity `progress` rows and PR-4 learner evidence (`learner.attempt_log`,
`learner.task_instance`, `learner.concept_mastery`). No new backend.

**The "adaptive learning API" does not exist.** It is PR-11 (`POST /api/next`, development plan §PR-11),
which depends on PR-7 and needs a goal model that doesn't exist yet. Per the user's decision
("UI + real data only"), **Current goal** and **Recommended next** render honest empty states. PR-11 later
fills them in without changing the layout.

## Decisions already made (user, 2026-09-13)

- Scope: UI + real data only. No goal schema, no `/api/next`, no mock numbers.
- Branch: new branch `feat/my-learning-overview` off `feat/pr-6-tutor-endpoint`, in a new worktree
  (`../vertex-my-learning`). This worktree's uncommitted dark-theme edits are not touched.

## Guidance read

- `AGENTS.md` (§2 invariants, §4 UI fidelity, §11 My Learning reads existing progress, §12 checks),
  `docs/PRODUCT.md` §9 ("Do not infer new backends from visual UI elements alone").
- `docs/Vertex_AI_Native_Development_Plan.md` §PR-4, §PR-9, §PR-11.
- `docs/DATA_MODEL.md` §16 authorization boundaries (rules for learner concept reads).
- To read before coding: `node_modules/next/dist/docs/01-app/01-getting-started/{03-layouts-and-pages,05-server-and-client-components,06-fetching-data,08-caching}.md`.

## Code inspected (PR-6 worktree)

- `db/migrations/0001_learner_evidence.sql`: `attempt_log` (`evidence_kind`, `correct`, `resolved_concept_id`,
  `created_at`), `task_instance.lesson_id`, `concept_mastery.evidence_status`, RLS `own_rows` for `vertex_learner_app`.
- `lib/db/learner-scope.ts` `asLearner()`, `lib/db/client.ts` `getDb()`: the only learner DB access path.
- `lib/flags.ts`: `learner-evidence` flag (fails closed).
- `lib/course-progress.ts` `summarizeCourseProgress`, `sanity/queries/progress.ts` `PROGRESS_FOR_USER_QUERY`.
- `studio/schemaTypes/documents/concept.ts`: `conceptId`, `reviewStatus`, `sourceStatus`, `lessons[]` refs.
- `components/home/site-header.tsx`, `components/ui/navigation.tsx` (`NavItem.active` exists, not wired),
  `components/ui/{card,button,icon,progress}.tsx`, `components/home/course-cover-tile.tsx`, `lib/format.ts` (`formatClock`, `pluralize`).
- `app/lessons/[slug]/page.tsx`: already resumes from stored progress, so resume links are plain `/lessons/[slug]`.
- Theme: PR-6 still has the light/orange tokens. The dark mint look in the design comes from the uncommitted
  token remap (`prompts/jsmastery-dark-theme.md`). The page uses tokens only, so it matches the design once that theme lands.

## Element → data source

| Design element | Source | Behavior |
| --- | --- | --- |
| Header, "My Learning" active | `SiteHeader` | Mark active from the pathname (small client nav wrapper). |
| Tabs: Overview / Knowledge map / Reviews | none | Overview active. The other two are visible but disabled (`aria-disabled`, no link): those pages don't exist. |
| Title + subtitle | static copy | As designed. |
| **Current goal** | none (PR-11) | Empty state: "No goal yet". Explains that goals are coming; no Edit goal, no progress bar, no fake %. |
| **Recommended next** | none (PR-11) | Empty state, no "Powered by…" label. Secondary action "Continue lesson" → resume lesson when one exists. |
| Continue learning tile | progress rows | Most recently touched incomplete lesson: "{lesson title} · Resume at {formatClock}". If none: "Browse courses" → `/courses`. |
| Due for review tile | none (PR-9) | Disabled tile, "Not available yet", no chevron/link. |
| Practice tile | none (PR-7) | Disabled tile, "Not available yet", no chevron/link. |
| My courses | progress + course query | Most recently active course: cover, title, description, "Lessons watched" = completed/total. "View all" → `/courses`. Empty state if no progress. |
| "Concepts with evidence" | approved concepts + `concept_mastery` | Denominator: published, `approved`, `sourceStatus == "current"` concepts whose `lessons[]` intersect the course. Numerator: those with `evidence_status = 'independent'`. Hidden when the flag is off, the DB is unavailable, or the denominator is 0. |
| Recent learning (3 rows) | `attempt_log` ⋈ `task_instance` + progress | Merged by timestamp, 3 at most: independent → "Independent practice"; assisted → "Practised with hints"; `answer_exposed` → "Practised with solution shown"; `not_counted` → "Repeated practice"; progress → "Resumed lesson" / "Completed lesson". Subtitle = lesson title. Relative time. No "View all" (no page). |

## Expected files

- `app/my-learning/page.tsx`: server component; `auth()`; signed-out state with sign-in button.
- `lib/learner/overview.ts`: server-only, `asLearner` reads: last 3 attempts (`attempt_log` join `task_instance`, `limit 3`)
  and independent concept ids (bounded). No writes.
- `lib/my-learning.ts` + `lib/my-learning.test.ts`: pure view-model (resume pick across courses, feed merge/labels, counts).
- `lib/learner/overview.db.test.ts`: RLS isolation (another learner's rows never appear), bound of 3.
- `sanity/queries/my-learning.ts`: courses with ordered lesson ids/titles/slugs; approved current concepts for a lesson id set
  (published perspective, drafts/versions excluded, bounded `[0...500]`). Then `npm run typegen` → `sanity.types.ts`.
- `components/my-learning/{learning-tabs,goal-card,recommended-next-card,quick-tile,course-summary-card,recent-learning}.tsx`.
- `components/ui/icon.tsx`: add `refresh`, `message`, `network` glyphs.
- `components/home/site-header.tsx` (+ small client nav wrapper) for the active state.

## Requirements / security

- Clerk user id from `auth()` only. Evidence reads only via `asLearner` (RLS), and only when `learner-evidence` is on and
  `DATABASE_URL` is set. Otherwise the page degrades to progress-only; a DB error degrades, never 500s.
- Never select private assessment fields. Show lesson titles only (no question text or answer keys).
- Every number and sentence on the page comes from stored data or is fixed UI copy; none of the mock's sample values
  ("7 of 11", "64%", "6 min", "logits and probabilities") are hard-coded.
- No client DB/Sanity access; no new API route; no PostHog events beyond existing page views.
- Desktop matches the design (two-column cards, three-tile row, two-column bottom). Below `md`, stack to one column.

## Acceptance criteria

- Signed-out: sign-in prompt, no data reads.
- Signed-in, no progress: all cards show empty states; no errors.
- With progress only (flag off): Continue learning, My courses (lessons watched), and Recent learning (progress rows) are populated;
  concept stat hidden.
- With evidence (flag on): concept stat and practice rows appear; another learner's attempts never appear.
- Current goal / Recommended next / Due for review / Practice never show invented data.

## Checks

- `npm run typecheck`, `npm run lint`, `npm test` (incl. `*.db.test.ts` against embedded Postgres), `npm run build`.

## Manual tests

1. `npm run dev` in `../vertex-my-learning`, sign out, open `/my-learning` → sign-in prompt.
2. Sign in as a learner with no progress → empty states throughout.
3. Watch part of a lesson, return → Continue learning shows that lesson and resume time; the link resumes playback there.
4. With `learner-evidence` on, answer a practice item (`/api/task-instances` + `/api/attempts`) → Recent learning shows
   "Independent practice · {lesson}"; concept stat counts it when the item has an approved primary concept.
5. Header shows "My Learning" active; Knowledge map / Reviews tabs are not clickable.

## Rollback

Delete the route and components; no data or schema changes.
