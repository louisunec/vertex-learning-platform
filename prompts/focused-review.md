# Focused review (My Learning → Reviews)

Status: **approved 2026-09-14** (with D2 changed to the 5-point labels) and **implemented** (committed locally, not pushed) in `../vertex-reviews` (`feat/focused-review` off `ff37283`).

## Goal

Implement the Focused review screen in `design/vertex-review.jpg` as the third My Learning tab. It serves reviewed concept questions chosen from the learner's recent mistakes, tracks session progress through `POST /api/review-session`, and gives each question a "Need a refresher?" row. That row links back to the lesson player at the question's cited source second.

## Guidance read

- `AGENTS.md` §2 (grounding: never invent counts or durations), §4 (the reference image is the source of truth), §9, and §12.
- `docs/Vertex_AI_Native_Development_Plan.md`:
  - §5 PR-9 (spaced review): this feature is a smaller V1 of it (see D1);
  - PR-4 (the evidence semantics);
  - PR-5 (the help policy).
- Memories: pr-4-status, my-learning-overview, knowledge-map, pr-7-lesson-integration, demo-dataset.

## Code inspected

- **Base candidate `feat/knowledge-map` (#15, `ff37283`, worktree `../vertex-knowledge-map`):**
  - `components/my-learning/learning-tabs.tsx`: Reviews renders disabled.
  - `app/my-learning/knowledge-map/page.tsx`: the page frame, sign-in, and flag pattern.
  - `lib/knowledge-map.ts`: `mapState`, `RECENT_EVIDENCE_DAYS`, `firstSource`, `lessonMomentHref`.
  - `lib/learner/knowledge-map.ts`: `readMapEvidence`, `readConceptAttempts`.
  - `lib/learner/{attempts,task-instances,evidence,contracts,help}.ts` and `lib/flags.ts`.
  - `db/migrations/0001_learner_evidence.sql`: the RLS role `vertex_learner_app`; every learner query goes through `asLearner`.
- **PR-7 (`3de183e`, local only, a sibling of #15):**
  - `lib/learner/lesson-check.ts`: server-side selection, grouping by resolved concept, and the unseen-variant rule.
  - `components/lesson/lesson-check.tsx`: the 1–5 confidence scale and the hint UI.
  - `CheckCandidate.firstSeconds`: the earliest cited source second.
- **Lesson deep link:** `app/lessons/[slug]/page.tsx` reads `?t=<seconds>`, and `components/search/video-result-card.tsx` and `lessonMomentHref` already build it. There is no `startSecond` parameter anywhere.
- **Not present:** `ts-fsrs` (not installed), any `review_*` table, and a duration or time estimate on `assessment`.

## Decisions (recommended defaults; the approval question can override D1–D3)

**D0. Base.**
- A new worktree `../vertex-reviews` on `feat/focused-review` off `feat/knowledge-map` (`ff37283`). The PR base will be #15.
- It doesn't depend on the unpushed PR-7. The review card is its own component: the design's lettered, monospace option rows differ from PR-7's check. The selection mirrors `selectFollowUp` rather than importing it.
- Expect small merges with PR-7 later, in `lib/flags.ts` and `sanity.types.ts`.
- The main checkout (`feat/pr-3-concepts`, with the user's dirty theme edits) is not touched.

**D1. Scope: a mistake-based V1, not the plan's full PR-9 scheduler.**
- **Recent mistake:** a concept qualifies when its latest counted attempt, within `RECENT_EVIDENCE_DAYS` (30), was not an independent correct answer. The reason is one of these (the evidence grades are PR-4's):
  - `independent_incorrect`;
  - `assisted_incorrect`;
  - `assisted_correct`: the screenshot's "your last correct answer used a hint".
- **Order:** by reason in the order above, then most recent first. At most **3 concepts**.
- **Items:** for each concept, approved families on the resolved concept, in any lesson, that the learner has **never answered**, in lesson order. At most 2 per concept and **5 in total**, so the answer is first independent evidence. A concept with no unseen family is dropped, because the plan says not to promise non-repetition. If every concept is dropped, the route returns the honest `none` state.
- **Deferred:** `ts-fsrs`, `review_card`, and `review_log` stay with a later PR-9. Nothing calls this spaced repetition.
- **Grounding changes to the reference:**
  - "Due today" → the reason chip, e.g. "Hint used last time".
  - "3 concepts · About 6 min" → "3 concepts · 5 questions", because no duration data exists.
  - The design's "due for another independent attempt" copy becomes the reason text.

**D1a. Session persistence (makes "Question 2 of 5" and "Save and leave" real).**
- An additive migration `0003_review_sessions.sql`:
  - `learner.review_session` (id, learner_id, created_at, expires_at = +24 h to match `TASK_INSTANCE_TTL_MS`, policy_version `review-v1`);
  - `learner.review_session_item` (session_id, learner_id, position, concept_id, reason, task_instance_id unique).
- RLS `own_rows`, select/insert only for `vertex_learner_app`. As with 0002, anon/authenticated get nothing through 0001's default-privilege revoke.
- **Progress** is derived by joining `attempt_log` on `task_instance_id`. It is never a client claim.

**D2. Confidence (user choice at approval: use the 5-point labels).**
- The review shows PR-7's five choices, 1 Guessing to 5 Certain, instead of the design's three pills, so the value is stored under the existing `pre_feedback_1to5_v1` signal.
- There is no change to `/api/attempts` or its contract.
- It's asked before feedback, and it's optional.
- This deviates from the reference: five pills where the design has three.

**D3. The refresher counts as help.**
- Opening "Need a refresher?" before answering exposes the source.
- Following its link calls `POST /api/review-session/refresher {taskInstanceId, requestKey}` (expanding only explains; see the implementation notes). That route records a `help_event` (level 1, reason `source_refresher`) for an item of the learner's own session and returns the `/lessons/<slug>?t=<startSeconds>` link, built with `lessonMomentHref`.
- **Effect on grading:** the attempt's `hint_level_used` becomes ≥ 1, so the attempt is assisted (the screenshot's footnote already says help is recorded).
- **Effect on hints:** `help.ts` leaves `source_refresher` events out when it picks the next hint rung, so "Give me a hint" still starts at hint 1. `attempts.ts` still counts them.
- The collapsed row shows only `formatClock(startSeconds)` ("05:41" is a timestamp, not a duration).
- An item with no cited source has no refresher row.

**D4. Route and page paths.**
- The page is `/my-learning/reviews`: the design's tab and breadcrumb win over the plan's `/review`, and the difference is noted in the PR.
- The deep link uses the existing `?t=` parameter, not a new `startSecond` parameter.

**D5. Flag.**
- A new PostHog flag `review-session`, which also requires `learner-evidence` and fails closed.
- Signed out, the page shows the existing `SignedOut` component and the routes return 401. With the flag off, both return 404.
- The tab links only when the flag is on (like `knowledgeMap`).

## API

`POST /api/review-session`
- **Request:** strict body `{}`.
- **What it does:**
  - resumes the learner's unexpired session that still has unanswered items (`resumed: true`);
  - otherwise builds a new one, issuing task instances through `insertTaskInstance` (extracted from `issueTask`) in one `asLearner` transaction under `pg_advisory_xact_lock` per learner, so two tabs can't create two sessions.
- **Reads:** Sanity outside the transaction, with the published perspective.

The response (strict Zod, validated before sending) is one of:
- `{status:'active', sessionId, expiresAt, resumed, concepts:[{conceptId, name, reason}], items:[{position, conceptId, state:'open', task, refresher:{lessonTitle, startSeconds}|null} | {position, conceptId, state:'answered'|'unavailable'}]}`
  - Only an open item carries its task.
  - No answer key, hint, source text, or slug is sent before the refresher is recorded.
- `{status:'none', reason:'no_recent_mistakes'|'no_unseen_questions'}`

**Answers and hints use the existing routes:**
- **Answers:** `POST /api/attempts`, unchanged (see D2).
- **Hints:** `POST /api/help` (`mode:'study'`).

**Errors:** the existing `learnerError` codes: 401, 404, `invalid_request`, and `failureResponse`.

## UI (desktop matches the reference; stacks to one column on narrow screens)

- **`app/my-learning/reviews/page.tsx` (server):** SiteHeader, LearningTabs `active="reviews"`, the "My Learning › Reviews" breadcrumb, the "Focused review" title and subtitle, then the client `ReviewSession`.
- **`components/my-learning/reviews/`:**
  - **`review-session.tsx`:** fetches the session and owns the state.
  - **`question-card.tsx`:**
    - the "Question n of N" progress bar and the concept · reason chip;
    - options A–D as a radio group in the mono font, with the selected row in mint;
    - the three confidence pills;
    - "Check answer" and "Give me a hint" (the hint text appears inline);
    - the footnote and the refresher row.
  - **`session-sidebar.tsx`:**
    - "Your session": each concept is Current · question i of N, Next, or Done.
    - "Why this review?": the reason text, the static evidence line, and "Save and leave" → `/my-learning`.
- **Not in the reference, so kept minimal:**
  - the graded state: a Correct or Not quite line with the evidence kind, then "Next question";
  - the completion card;
  - the `none` state;
  - loading and error states. A failure is never shown as an empty state.
- **Tabs:** `LearningTabs` gains `reviews`. The overview and knowledge-map pages pass the flag.
- **PostHog:** `review_session_started`, `review_answer_checked`, and `review_refresher_opened`, following PR-7's event pattern. Payloads carry ids and booleans only.

## Expected files

- `db/migrations/0003_review_sessions.sql`
- **`lib/learner/`:**
  - `review-session.ts` with pure selection plus DB functions;
  - `review-session.test.ts`, `review-session.db.test.ts`, and `review-route.db.test.ts`;
  - edits to `contracts.ts`, `attempts.ts`, and `help.ts`.
- **Sanity:** `lib/ai/help-policy.ts` (the reason code), `sanity/queries/*` (`REVIEW_CANDIDATES_QUERY`, by concept ids, bounded), `sanity/data` (`getReviewCandidates`), and `sanity.types.ts` (typegen).
- **Routes and flag:** `lib/flags.ts`, `app/api/review-session/route.ts`, and `app/api/review-session/refresher/route.ts`.
- **Pages and components:** `app/my-learning/reviews/page.tsx`, `components/my-learning/reviews/*.tsx`, `components/my-learning/learning-tabs.tsx`, `app/my-learning/page.tsx`, and `app/my-learning/knowledge-map/page.tsx`.

## Security

- Identity comes only from `auth()`. The bodies are strict, and the client never names an assessment, concept, or level.
- Every learner read and write goes through `asLearner` (RLS). A refresher for another learner's task instance, or one outside a session, returns 404.
- The responses contain no answer keys and no hints beyond the one decided rung. Nothing private reaches the browser.

## Acceptance

- **Selection:** unit tests cover the reason order, the 30-day window, the caps (3 concepts and 5 items), the unseen-only rule, dropped concepts, merged concepts resolving through `resolveConcept`, and the `none` reasons.
- **Database tests:**
  - resume versus a new session;
  - concurrent starts creating one session;
  - progress coming from `attempt_log`;
  - an expired session not resumed;
  - cross-learner isolation;
  - a refresher making the next attempt assisted, while hints still start at rung 1;
  - a `1to3` confidence value stored with the new signal, with `4` rejected.
- **Route tests:** 401 signed out, 404 with the flag off, and a strict body.
- **Page:** the `?t=` link opens the lesson at the second, using the existing lesson-page behavior.

## Checks

Run in `../vertex-reviews` with node 22 (see local-toolchain-gotchas). First run `npm ci`, `npm ci` in `studio/`, copy `studio/schema.json`, and run `npx next typegen`. Then run `npm run typecheck`, `npm run lint`, `npm test` (the DB tests use the embedded Postgres), and `npm run build`.

## Manual tests

1. Signed out: open `/my-learning/reviews` and see the sign-in state; `POST /api/review-session` returns 401.
2. With the flag off: the page returns 404 and the tab is disabled.
3. Signed in with the flag on, in the `../vertex-demo` dataset and Postgres (:54330), using an account whose history has a wrong or hinted answer:
   1. The session lists up to 3 concepts, each with its reason.
   2. Answer question 1, then reload: the page resumes at question 2.
   3. Choose "Save and leave", then return: the session resumes.
   4. Expand the refresher: the link opens `/lessons/<slug>?t=<s>` and playback starts at that second. The next answer is recorded as assisted.
4. With no recent mistakes: the honest `none` state is shown.

**Cannot be run now:** production has 0 assessments and 0 concepts, and the demo content is still blocked on recordings and review. So the signed-in browser flow will probably stay unverified.

## Rollback

Turn off `review-session`. Migration 0003 only adds tables, so they can stay. Don't apply it to production (a standing user instruction).

## Implementation notes (2026-09-14)

**Where:** worktree `../vertex-reviews`, branch `feat/focused-review` off `feat/knowledge-map` (`ff37283`). Uncommitted; nothing is pushed or applied to any live database.

**How it differs from the plan above:**

- **Refresher interaction:** expanding the row only explains what happens. The **Watch from 05:41** button then calls the refresher route, which records the help event, and navigates in the same tab to the returned `?t=` link. The session resumes on return. The footnote now names the refresher as assisted practice too.
- **Hint ladder:** without the `getInstanceHelpLevel` filter, the first hint after a refresher would still be rung 1 (`decideHelpLevel` repeats the current level for a plain `hint` request), but it would be logged as `repeat_current`. The filter keeps the reason code `first_help`.
- **Reason copy:** it says "used help", not the design's "used a hint", because assisted also covers the refresher and a shown solution. The chips read "Missed last time", "Missed with help", and "Answered with help".
- **Reused refresher keys:** `help.ts` `helped()` rejects a request key first used for a refresher as `idempotency_key_reused`. Without this, `/api/help` returned 500 on the reason-code schema. `source_refresher` is deliberately not in `HELP_REASON_CODES`, and `SOURCE_REFRESHER_REASON` lives in `help-events.ts`, not `lib/ai/help-policy.ts`.
- **Outbox:** the refresher writes no outbox event, because it isn't a help-policy decision.
- **PostHog:** `review_session_started`, `review_answered`, `review_refresher_opened`, and `hint_escalated` with `source: 'review'`. Ids, counts, and booleans only.
- **Refactor:** `insertTaskInstance(tx, …)` is extracted from `issueTask`, whose behavior is unchanged, so a session issues its instances inside its own transaction.
- **Icon:** `components/ui/icon.tsx` gains an `info` glyph for the footnote.
- **Unresolved concept name:** shows "Concept no longer available" (a nullable `name`).

**Merge notes for PR-7 (`3de183e`):**

- These are byte-identical copies, so they merge cleanly:
  - `lib/lesson/{api,help-actions}.ts`;
  - the `CheckCandidate` / `toCheckCandidates` block in `lib/assessments/learner.ts`.
- These will need small manual merges:
  - `LearnerContentSource` (PR-7 adds `loadLessonCheckCandidates`) in `content-source.ts`, `content.ts`, and `test-content.ts`;
  - `lib/flags.ts`;
  - `sanity.types.ts`.
- **Test truncation:** migration 0003 references `task_instance`. So the existing DB tests' `truncate` lists and `migrate.db.test.ts` were updated, as PR-6 did for `tutor_request`. PR-7's `lesson-check*.db.test.ts` need the same `learner.review_session_item, learner.review_session` prefix after a merge.

**Verification:**

- **Tests:** 593/593 pass, run with `TEST_DATABASE_URL` against the embedded Postgres on :54329 and the ffmpeg env. They include:
  - 18 new unit tests;
  - 12 new database tests;
  - 4 new route tests.
- **Checks:** `npm run typecheck`, `npm run lint`, and `npm run build` pass. The build lists `/my-learning/reviews`, `/api/review-session`, and `/api/review-session/refresher`.
- **Visual:** a temporary harness page (deleted) rendered the real `QuestionCard` and `SessionSidebar` with fixture data at 1224px, and the result matches the reference apart from the D1 and D2 deviations. At 400px the columns stack. The headless-Chrome capture is clipped at 400px, and so is the existing Overview page, so that is a tool limit.
- **Signed out:** `/my-learning/reviews` returns 200 with the sign-in card.
- **Not verified:** the signed-in browser flow. The `review-session` PostHog flag doesn't exist yet, the preview env has no `DATABASE_URL`, and live `production` has 0 concepts.
