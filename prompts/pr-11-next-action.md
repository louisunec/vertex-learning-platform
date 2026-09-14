# PR-11: Evidence-based next action, learning goal, and `/learn`

Status: **implemented on 2026-09-14 under the user's explicit instruction** to work through implementation and verification without stopping after a planning document (the CLAUDE.md bypass). Committed and pushed for review at the user's request, with the PR against `feat/pr-11-base`. Not merged into main or deployed.

## Goal

A signed-in learner can:

1. choose an existing course as their current goal on My Learning;
2. see one clear next action there, with the reason for it;
3. open `/learn` for a short, ordered plan (normally 3 to 5 items);
4. jump to the right lesson and source second (`?t=<seconds>`);
5. after completing a check or a review, see recommendations built from the newly recorded evidence.

Missing evidence is never described as weakness or mastery.

## Guidance read

- `AGENTS.md`, `CLAUDE.md`, and memory.
- `docs/Vertex_AI_Native_Development_Plan.md`: §3 (contracts, authorization), §4 (dependencies), §5 PR-4/PR-7/PR-9/PR-11.
- Prompts: `prompts/my-learning-overview.md`, `knowledge-map.md`, `focused-review.md`, `pr-7-lesson-integration.md`; `../vertex-my-learning/prompts/live-demo-integration.md`.
- Next.js docs: `01-app/01-getting-started/{03-layouts-and-pages,05-server-and-client-components,15-route-handlers}.md`.

## Base and branch

- **Worktree:** `../vertex-pr-11`, branch `feat/pr-11-next-action`.
- **Base:** `df9fc39` (`feat/focused-review`, which sits on #15 `ff37283`), plus two merges:
  - `b20906f`: merge of `ca953e3` (#14 review fixes);
  - `2e0384a`: merge of `3de183e` (PR-7).
  - The conflicts were the ones the preview merge had already resolved (`video-embed.tsx` comment, additive `flags.ts`/`content-source.ts`/`content.ts`/`test-content.ts`, and the lesson-check test truncates). Those files were taken from `preview/my-learning` `1a6945d`, with PR-2's `searchVisualEvidence` flag removed. PR-2 is **not** in this branch.
- **Why this base:**
  - PR-11 depends on PR-3/4/7 (plan §4). PR-7's lesson check is the only implemented route that can deliver a *diagnostic*: it serves the first concept group in a lesson that the learner has never answered.
  - PR-7's check never re-serves a concept the learner has already answered (a group is "open" only while all of its families are unanswered). Focused review (`planSession`: unseen families of recent mistakes) is the only implemented route that delivers *practice* on a weak concept.
  - PR-9 (`../vertex-pr-9`) uses the same `df9fc39` base.
- **PR base for review:** `feat/pr-11-base` (= `2e0384a`, the dependencies above), so the diff is PR-11 alone. Retarget to the stack branch once PR-7 and focused review have their own PRs.

## Code inspected

- **Evidence and graph:**
  - `lib/learner/evidence.ts` (`classifyEvidence`, `projectMastery`);
  - `lib/knowledge-map.ts` (`mapState`, `resolveEvidence`, `evidenceIdsFor`, `firstSource`, `lessonMomentHref`, `orderConcepts`, `numberedLessons`, `drawableEdges`);
  - `lib/concepts/{graph,resolve}.ts`;
  - `lib/learner/knowledge-map.ts` (`readMapEvidence`).
- **Delivery:**
  - `lib/learner/lesson-check.ts` (`groupCandidates`, `selectCheckItem`);
  - `lib/lesson/{features,resolve-features}.ts`;
  - `lib/learner/review-session.ts` (`pickMistakes`, `planSession`, `conceptRefsFor`, `findActiveSession`);
  - `app/api/{lesson-check,review-session}/route.ts`.
- **Learner access:** `lib/db/{learner-scope,client,migrate,test-db}.ts`, `lib/learner/{http,contracts,content,content-source,test-content}.ts`.
- **Flags and pages:** `lib/flags.ts`; `app/my-learning/{page,knowledge-map/page,reviews/page}.tsx`; `components/my-learning/*`; `lib/my-learning.ts`.
- **Sanity:** `sanity/queries/{my-learning,assessments,courses,progress}.ts`; `sanity/data/*`; `studio/schemaTypes/documents/{concept,concept-prerequisite,assessment}.ts`, `objects/concept-source-ref.ts`.

## Decisions

1. **Goal model.**
   - Migration `0005_learning_goal.sql` adds `learner.learning_goal`: one row per learner holding `learner_id`, `goal_kind` (`'course'` only for now, checked), `course_id`, `set_at`, and `updated_at`.
   - Row-level security uses the same `own_rows` policy as 0001. The table grants `select, insert, update(goal_kind, course_id, set_at, updated_at)` and no DELETE.
   - The number skips 0003 (Focused review) and 0004 (PR-9, confirmed with that session). The migrator applies pending files in name order, so a gap is fine.
2. **Goal write.**
   - `POST /api/goal {courseId}` resolves identity from `auth()` and returns 401 before any flag check. It returns 404 unless `next-action` and `learner-evidence` are both on.
   - The body is strict. The course must be published (no draft or version id, slug defined), or the route returns 404.
   - The write is an upsert under `asLearner`. A goal is saved only by this explicit request; nothing infers one.
3. **`POST /api/next {courseId?}`.**
   - Same gating as the goal route.
   - `courseId` previews a plan for another accessible course without saving it. By default the stored goal is used.
   - The response passes the strict Zod contract `nextActionResponseSchema` in `lib/learner/next-action-contracts.ts`, a separate file so that PR-9's edits to `contracts.ts` don't conflict.
4. **Accessible course.** This is the existing access rule, checked against the code on 2026-09-14.
   - No entitlement model exists. Browsing is public (AGENTS §11), `priceDisplay` and `freePreview` are display-only per the Studio schema, and `proxy.ts` protects no course or lesson route.
   - A course a learner can reach is exactly what the catalogue (`COURSES_QUERY`) and the course page list: a published course with a slug.
   - The goal and plan queries apply the same rule, and also exclude draft and version ids explicitly.
   - Lessons dereference in the published perspective. A lesson that is unpublished or has no slug (so has no lesson page) is dropped.
5. **Deterministic only.**
   - Candidates, ranking, reasons, and links all come from server data.
   - There is **no LLM ranking**: no reviewed evaluation set exists to show it adds value, and the task says not to put a model in the critical path without demonstrated value.
6. **Reused classification.**
   - A concept's state is the knowledge map's `mapState`, fed by `resolveEvidence` over `concept_mastery` plus each concept's latest independent attempt.
   - A prerequisite counts as *demonstrated* only when its latest independent response was correct (the knowledge map's `recent_evidence`, or `developing` with independent evidence). Assisted-only and unknown never satisfy a prerequisite.
   - **Evidence age.** Historical evidence is kept (it is read with no time window), and it is described with the knowledge map's own rule.
     - If every prerequisite's latest correct answer is within `RECENT_EVIDENCE_DAYS` (30), the item gets `prerequisites_demonstrated`: "…correctly on your own within the last 30 days."
     - If any is older, the item gets `prerequisites_demonstrated_earlier`, which ranks after recent confirmation. It names the prerequisite and its age, e.g. "…was 1 month ago. Answers older than 30 days count as developing, not recent evidence."
     - Age alone is never failure: an older correct answer still satisfies readiness, and the concept itself isn't offered as a weak revisit.
     - Provenance records each prerequisite's map `state` and `latestIndependentAt`.
   - There is no second mastery model and no use of `estimate`.
7. **Graph.**
   - Only published, approved, current edges whose dependent is a goal-course concept are read.
   - Edges between goal-course concepts go through `drawableEdges` (`validateGraph`). A concept touched by a dropped edge gets readiness `unverified`.
   - For an edge from a concept outside the course, the endpoint must resolve to an active approved concept. It is then satisfied only by demonstrated evidence; if the endpoint doesn't resolve, the readiness is `unverified`.
   - A concept with no edges gets readiness `none_recorded`, and its reason says no prerequisites are recorded. It never claims readiness.
8. **Actions and delivery.**

   | Kind | When | Primary link | Delivery flag |
   | --- | --- | --- | --- |
   | `practise` | Focused review would serve a goal-course concept now: the learner's active Mistakes session, or `planSession` over `pickMistakes` | `/my-learning/reviews` | `review-session` (`isReviewEnabled`) |
   | `continue` | The most recent started, incomplete lesson in the goal course | `/lessons/<slug>?t=<resume>` | none |
   | `learn` | A `not_assessed` concept in a lesson not yet completed, with readiness `met`, `none_recorded`, or `unverified` | `/lessons/<slug>?t=<span start>` | none |
   | `learn` (revisit) | A concept whose latest evidence is weak (`needs_practice`, or assisted-only) and that Focused review can't serve | the source span | none |
   | `diagnose` | The lesson check would issue an item now, and that item's concept is `not_assessed` | `/lessons/<slug>` (the check sits under the video) | `lesson-integration` + `learner-evidence` |
   | `next_lesson` | Course-order fallback: the first incomplete lesson not already in the plan | `/lessons/<slug>` | none |

   - There is no `review`/"due" action: no scheduler exists in this stack (PR-9 is separate).
   - There is no PR-8 input: the `explanation_log` table has no writer.
9. **Ranking.**
   - Tiers, in order:
     1. practise;
     2. continue;
     3. learn with prerequisites recently demonstrated;
     4. learn with prerequisites demonstrated only by older evidence;
     5. revisit;
     6. diagnose (at most 2);
     7. learn with readiness `none_recorded` or `unverified`, together with the course-order lesson (at most 1).
   - The last tier is shared, so the part of a plan that says it "follows course order" really is in course order.
   - Within a tier, items follow course order: lesson number, then start second, then title, then id. A plain lesson item sorts after any concept item in the same lesson.
   - At most one lesson-watch item (continue, learn, or next lesson) per lesson. At most 5 items in all.
10. **Spans and durations.**
    - The span is the first contiguous run (gaps of at most 2 s) of the concept's cited chunks in its earliest lesson.
    - Duration is shown only as the lesson's stored `durationSeconds`, or the span's stored end minus start. Practice and checks show no duration.
11. **States.**
    - Page-level states: `no_goal`, `goal_unavailable` (the course was unpublished), `ready`, and errors. A content read failure and a learner-data failure both surface as an error, never as an empty plan.
    - Notices: `no_reviewed_concepts`, `no_prerequisite_edges`, `prerequisite_graph_defects`, `no_evidence_no_check`, `no_eligible_concept`, `course_complete`.
12. **Provenance.**
    - Every item carries `reasonCode`, `tier`, and a strict `provenance` object: evidence counts and state, readiness and prerequisite ids, the progress row, source chunk ids, the delivery route, and check or review details.
    - The UI doesn't render provenance.
    - Nothing about recommendations is written: impressions and clicks never touch mastery.
13. **Flag.**
    - `next-action` (`FLAGS.nextAction`), which also requires `learner-evidence`, because the goal and the evidence live in the learner database.
    - Off means My Learning is unchanged (the existing `NextStepCard`), `/learn` returns 404, and both routes return 404.
    - The flag isn't created or enabled in PostHog by this work.

## Files

- **Database:** `db/migrations/0005_learning_goal.sql`; `lib/db/migrate.db.test.ts` (lists).
- **Planner:** `lib/next-action.ts` (pure planner), with `lib/next-action.test.ts`.
- **Services:**
  - `lib/learner/goal.ts`: goal reads and writes under `asLearner`.
  - `lib/learner/next-action.ts`: the service, which reads and then plans.
  - `lib/learner/next-action-source.ts`: the content source type.
  - `lib/learner/next-action-content.ts`: its Sanity implementation.
  - `lib/learner/next-action-contracts.ts`: the Zod contracts.
- **Service tests:** `lib/learner/next-action.db.test.ts`, `lib/learner/next-route.db.test.ts`.
- **Queries:** `sanity/queries/next-action.ts`, with `lib/next-action-query.test.ts`; then regenerate `sanity.types.ts`.
- **Routes:** `app/api/next/route.ts`, `app/api/goal/route.ts`.
- **Flags:** `lib/flags.ts`.
- **Pages and components:**
  - `app/learn/page.tsx`;
  - `components/learn/{plan-item,goal-picker,plan-notices}.tsx`;
  - `components/my-learning/{goal-card,recommended-card}.tsx`;
  - `app/my-learning/page.tsx`;
  - `components/my-learning/coming-soon.tsx`.

## Security

- The learner id comes only from `auth()`. Bodies are strict, so a `userId`, a level, or an assessment id is rejected.
- Every learner read and write runs under `asLearner` (row-level security). Content reads use the published perspective, with drafts and versions excluded.
- No answer key, hint, or question text is read by the planner. Review and check candidates are used for ids, families, and seconds only.
- Nothing new reaches the browser beyond course and lesson titles, concept names, seconds, and the learner's own evidence counts.

## Acceptance

- The flag gates and signed-out 401s are proven by route tests, including that no content or database access happens first.
- Learner isolation is proven through real row-level security.
- Draft, rejected, stale, and unpublished content is excluded, proven by query tests.
- Prerequisite readiness and invalid-graph handling are proven by the planner tests.
- Assisted and independent evidence are handled differently.
- Every cold-start state is explicit.
- Ordering is deterministic.
- Links use `?t=` with correct seconds.
- A plan changes after new evidence, proven through the real attempt service.
- Failures throw and are never empty plans.

## Checks

`npm run typecheck`, `npm run lint`, `npm test` with `TEST_DATABASE_URL` pointing at an isolated embedded Postgres (port 54332, this session's scratchpad), and `npm run build`. Browser checks on a port other than 3000, 3333, or 3334.

## Rollback

Turn `next-action` off. My Learning returns to `NextStepCard`, and `/learn` and both routes return 404. The `learning_goal` table stays (additive).

## Implementation notes (2026-09-14)

### Where it lives

- **Branch.** Worktree `../vertex-pr-11`, branch `feat/pr-11-next-action`. The PR-11 work is one commit on top of `2e0384a`, which holds the two base merges.
- **PR base: `feat/pr-11-base`,** pushed at `2e0384a`. That is exactly PR-11's dependencies:
  - focused review `df9fc39` (no PR yet, off #15 `ff37283`);
  - #14's head `ca953e3`;
  - PR-7 `3de183e` (no PR yet, off #14).
  No remote branch held all three, so the PR diff is PR-11 alone. Retarget the PR once focused review and PR-7 have their own PRs in the stack.
- **Local files.** `.env.local` is a copy of `../vertex-reviews/.env.local`; the `DATABASE_URL` for this session's stopped isolated database is commented out. `studio/schema.json` was copied from `../vertex-reviews` for TypeGen.

### Deviations from the plan and the task

- **No LLM ranking.** Ranking is fully deterministic (decision 5).
- **No `availableMinutes`.** It is not accepted by `POST /api/next`: no stored data supports practice or check durations. Only lesson and span durations are shown.
- **Body field.** `POST /api/next` takes `courseId` (a published course to preview), not `goalId`: a learner has one goal row, so there is no goal id to pass.
- **One practice item.** Focused review serves a whole session, so the plan has at most one practice item. It names the first goal-course concept in that session and says how many other concepts the session covers. Separate per-concept items would all open the same page.
- **Diagnose** is PR-7's own lesson check, reached by opening the lesson page (the check sits under the video). There is no deep link to the check itself, and PR-7's components weren't changed. The item says "Take the check".
- **Older evidence.**
  - An independent correct answer older than 30 days (`developing`) produces no action for that concept: there is no scheduler, so nothing is called "due".
  - As a prerequisite, it still counts, but the reason gives its age and ranks it after recent confirmation (decision 6).
- **No analytics events.** None were added for plan impressions or clicks. Nothing about a recommendation is ever written.

### Verification (this worktree, 2026-09-14)

- **Checks:**
  - `npm run typecheck` and `npm run lint` pass (0 problems).
  - `npm test` passes **676/676** with `TEST_DATABASE_URL`, against an embedded Postgres 17 on port 54332 in this session's scratchpad (`pg/`), never a shared cluster.
  - `npm run build` passes.
- **New tests:**
  - `lib/next-action.test.ts` (25): cold start, no concepts, course complete, prerequisite gating, older prerequisite evidence (still counted, age stated, ranked after recent, never read as failure), assisted/missed/unknown evidence never satisfying a prerequisite, cycles and not-approved external prerequisites (`unverified`), revisit wording, focused-review and lesson-check delivery gating, continue and resume bounds, determinism under shuffled input, the plan limit, course order, spans, and the contract.
  - `lib/next-action-query.test.ts` (6): the real GROQ via groq-js. It excludes drafts, rejected, `needs_review`, stale, merged, and unpublished-lesson content; there are no private assessment fields; and the row parsers.
  - `lib/learner/next-action.db.test.ts` (9): real row-level security and real services.
    - No goal is ever inferred. Goals are isolated between learners (read, update, and insert as another learner all fail).
    - A cold plan offers checks.
    - Planning is read-only: no evidence, tasks, or help rows are written.
    - **The plan changes after new graded evidence:** a missed check answer yields "Start focused review"; the review resumes; a correct unseen variant then demonstrates the prerequisite and unlocks the dependent. Bob's plan is unaffected throughout.
    - Assisted answers never demonstrate a prerequisite.
    - A withdrawn goal and a rejected preview are handled explicitly.
    - Content and database outages throw; they are never an empty plan.
  - `lib/learner/next-route.db.test.ts` (5): the real route handlers.
    - 401 before any flag check.
    - 404 unless both flags are on, with no database or content access.
    - Strict bodies.
    - The session's identity only.
    - `lesson-integration` gates check items.
    - A content outage returns 503 with `retryable`.
- **Browser** (`next dev -p 3011`, headless Chrome over a pipe, production Sanity **read-only**, isolated database `vertex_pr11_dev`), with three throwaway Clerk dev users, each deleted afterwards with its session revoked:
  - **Signed out:** `/learn` asks for sign-in, and `/api/next` returns 401.
  - **Flags forced on** (a temporary env-guarded line in `lib/flags.ts`, since reverted; the file is byte-identical to the pre-patch copy):
    - With no goal, My Learning shows "No goal yet" with the picker beside the existing next-step card, and Coming soon lists only "Practice".
    - Choosing Practical Web Security through the UI saved exactly one goal row, for that user only.
    - `/learn` then showed 3 items in course order: Lesson 1 (course order), Lesson 2 (Authentication vs Authorization, 0:00–1:58), and Lesson 7 (Server-side sessions, 0:41–2:38). It also showed the `no_prerequisite_edges` and `no_evidence_no_check` notices.
    - A body with a `userId` returned 400. `?t=41` opened the lesson with the YouTube embed at `start=41`.
    - There was no horizontal overflow at 390 px on `/learn` or `/my-learning`.
  - **Fixture evidence:** one independent incorrect answer, inserted for the throwaway user in the isolated database only. It moved "Revisit" for that concept to the top, with the evidence-based reason. The fixture rows were deleted.
  - **Flags off** (real PostHog evaluation; `next-action` doesn't exist there): `/learn`, `/api/next`, and `/api/goal` return 404, and My Learning is unchanged, with Coming soon listing Learning goals and Recommendations again.
  - **Afterwards:** 0 `progress` documents exist in production for the test users, and the isolated database holds 0 goal, attempt, task, or mastery rows.
- **Not verified:**
  - Practice items, check items, and a real answer changing the plan, on live content.
    - A recount on 2026-09-14 (production, raw perspective) found 12 published approved/current concepts, 0 published assessments (18 drafts, all `needs_review`), and 0 `conceptPrerequisite` edges, published or draft.
    - Nothing can be served yet, so these rest on the database tests, not live behaviour. Unreviewed content was not published.
  - Real PostHog targeting of `next-action`: the flag doesn't exist yet.
  - Supabase: the migration was applied to local Postgres only.
  - Any signed-in flow with the user's own account.

### Integration into `localhost:3000` (`../vertex-my-learning`, `preview/my-learning`)

Only the integration session changes the preview checkout or restarts `:3000`.

- **The two PR-9 adjustments are now resolved on this branch,** so they need no hand edits after a merge:
  - `readActiveReview` reads focused review's own `findActiveSession`. With PR-9 present, that function defaults to `mode = 'mistakes'`, so a Scheduled session is never presented as practice.
  - The next-action database test truncates with `cascade`. That empties PR-9's `review_log` (it references `attempt_log`) but not `review_card` (it references none of them), so the integration branch lists `learner.review_card` explicitly.
- **Prepared merge (local branch `integration/pr-11-preview`).** A merge of this branch into preview `b2c409c`, with the textual conflicts resolved:
  - `lib/flags.ts`: keep PR-2's and PR-9's flags, plus PR-11's `nextAction`, `isNextActionEnabled`, and `nextActionCapabilities`.
  - `app/my-learning/page.tsx`: keep both.
    - Flags `[knowledgeMap, reviews, scheduled, nextAction]`, with a fallback of four `false`s.
    - `Overview` reads `[progress, evidence, due, plan, goalCourses]`.
    - `DueReviews` renders before `ComingSoon`.
    - Keep both helpers, `readDueReviews` and `goalCardState`.
  - `lib/db/migrate.db.test.ts`: all tables, migrations 0001 to 0005, and both grant sets.
  - `lib/learner/lesson-check{,-route}.db.test.ts`: the preview's side (the conflict comes only from this branch's pre-PR-9 base merge).
  - `lib/learner/review-session.ts`: PR-9's `findActiveSession` (with `mode`), keeping PR-11's `export` of `readLatestCounted` and `readAnsweredFamilies`.
  - `sanity.types.ts`: git's merge, which carries both PR-2's and PR-11's types. Don't regenerate it from `studio/schema.json`, which lacks PR-2's `videoVisualIndex`.
  - A follow-up commit on the integration branch adds `learner.review_card` to the next-action test's `truncate`.
- **Steps for the integration session:**
  1. In `../vertex-my-learning`, run `git merge --ff-only integration/pr-11-preview`. If the preview has moved past `b2c409c`, run `git merge integration/pr-11-preview` instead; the conflicts are already resolved inside it.
  2. Migration `0005_learning_goal.sql` was already applied to `vertex_local` by the PR-11 session, after a schema check and a backup. `npm run db:migrate` should report "Up to date."
  3. Run `npm run typecheck`, `npm run lint`, and `npm test` (with `TEST_DATABASE_URL` pointing at a throwaway cluster), then restart only `next dev -p 3000`.
  4. **The user's step: the flag.** Create PostHog `next-action` off, and then target the user's own Clerk id once the checks below pass. It also needs `learner-evidence`. Practice items appear only with `review-session`, and check items only with `lesson-integration`.
- **Before enabling the flag for the user:**
  - `learner.schema_migrations` lists 0001 to 0005 with matching checksums.
  - `learner.learning_goal` exists with RLS.
  - Preview HEAD contains `feat/pr-11-next-action`.
  - `learner-evidence` is on for the user.
- **Rollback:** turn `next-action` off (or don't create it). The preview can be reset to its pre-merge commit; the `learning_goal` table is additive and can stay.
