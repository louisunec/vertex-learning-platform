# PR-9: Scheduled review (FSRS) on top of Focused review

Status: **approved 2026-09-14** (user answered "Yes") and implemented on `feat/pr-9-scheduled-review` in `../vertex-pr-9`. See "Implementation notes" at the end.

## Goal

Add a second review mode to My Learning → Reviews. Plan §5 PR-9 specifies it:

- a maintained scheduler (`ts-fsrs`);
- durable per-learner review state;
- an honest mapping from graded answers to scheduler ratings.

Focused review's targeted mistake practice stays exactly as it is, as the **Mistakes** mode. **Scheduled** is a distinct mode that serves what the scheduler says is due. Neither self-confidence nor an assisted correct answer is ever turned into an FSRS rating.

## Guidance read

- `AGENTS.md`, `CLAUDE.md`, and memory.
- `docs/Vertex_AI_Native_Development_Plan.md` §3 (versioning and consistency), §5 PR-4, PR-7, PR-9, and §6 (release gates).
- `prompts/focused-review.md`.
- Still to read at implementation, before editing:
  - the installed `ts-fsrs` README and types (`node_modules/ts-fsrs`);
  - `node_modules/next/dist/docs/01-app/` route-handler and dynamic-rendering pages, for the new route body and the overview read.

## Code inspected (base `feat/focused-review` `df9fc39`)

- **`lib/learner/review-session.ts`** (Mistakes mode):
  - a concept qualifies when its latest counted attempt in 30 days was not an independent correct answer;
  - it serves only never-answered families, at most 2 per concept, 3 concepts, and 5 items;
  - sessions are pinned as task instances under a per-learner advisory lock;
  - its header says it stores no scheduler state.
- **`db/migrations/0003_review_sessions.sql`:**
  - `review_session` and `review_session_item`;
  - `reason` is checked against the three mistake reasons;
  - RLS is on, and `vertex_learner_app` has select and insert only.
- **`lib/learner/attempts.ts` `submitAttempt`:**
  - the attempt, the mastery projection, and the outbox row are written in one `asLearner` transaction, under `lockLearnerFamily`;
  - `classifyEvidence` makes any repeat of a family `not_counted`;
  - `hint_level_used` and `answer_exposed` come from server help history, never from the client.
- **`lib/learner/evidence.ts`:** the `independent`, `assisted`, and `not_counted` kinds; level 3 is answer exposure.
- **`lib/learner/contracts.ts`:**
  - `attemptResultSchema` (strict);
  - `reviewSessionRequestSchema = z.strictObject({})`;
  - `REVIEW_REASONS` and `REVIEW_NONE_REASONS`, with `MAX_REVIEW_ITEMS = 5`.
- **`sanity/queries/assessments.ts`:**
  - `REVIEW_CANDIDATES_QUERY` projects `item.type`;
  - `GRADING_ASSESSMENT_QUERY` does **not** select `type`.
- **Routes and pages:** `app/api/review-session/route.ts`, `app/my-learning/reviews/page.tsx`, and `components/my-learning/reviews/*`.
- **`lib/flags.ts`:** `review-session` requires `learner-evidence`. The public `app/page.tsx` calls no `auth()`.
- **`ts-fsrs`:** `5.4.2` is `latest` on npm (checked today), with `engines: node >=20`. It is not installed anywhere yet.

## Decisions

1. **Card scope: learner + concept + item type** (`recall` / `apply` / `transfer`).
   - In this repo a `familyId` is the versions of *one* question, not a group of equivalent questions. The nearest reviewed grouping is concept × type: the reviewer approves `type` as part of the item.
   - The plan's rule is honoured: recognition and transfer never share a card.
   - The concept is the stable `conceptId` resolved at grading time. Merges are followed at read time, as Mistakes mode does. A split or withdrawn concept's cards are not served.
2. **Which answers update a card:** every graded attempt with an active concept, from the lesson check, Mistakes, or Scheduled, while `scheduled-review` is on.
   - With the flag off, attempts never touch cards, and there is no backfill from `attempt_log`. That keeps the plan's "don't infer scheduler state from attempt_log".
3. **Rating adapter** (`lib/review/rating.ts`, pure, versioned `rating-v1`). Its inputs are exactly the server-derived `correct`, `hintLevelUsed`, and `answerExposed`. Self-confidence is not a parameter, so the type system enforces that rule.

   | Server facts | FSRS action |
   |---|---|
   | no help, not exposed, correct | rate **Good** |
   | no help, not exposed, incorrect | rate **Again** |
   | any help or exposed, incorrect | rate **Again** |
   | any help or exposed, correct | **no rating.** A `review_log` row with outcome `unrated_assisted_correct` is written, and the card state is unchanged. A card that didn't exist yet is created **New** (due now, unrated), meaning it still needs an independent observation. |

   - Hard and Easy are never produced.
   - A repeat answer (`not_counted` as mastery evidence) is still a valid retention observation for FSRS, so the adapter uses help facts, never `evidence_kind`.
   - PR-4 mastery is unchanged: a repeat still adds no independent-mastery evidence.
4. **Where it runs:** inside `submitAttempt`'s existing transaction, after the attempt insert. The route evaluates the flag and passes it in as a boolean.
   - The card row is locked with `select … for update`, after an `insert … on conflict do nothing`. That lock sits alongside the family lock, because one card spans several families.
   - An idempotent replay returns the stored attempt and writes nothing, because `review_log.attempt_id` is unique.
   - The outbox gets no new event type; the outbox still has no dispatcher.
5. **Scheduled sessions** reuse `review_session` and `review_session_item` with a new `mode` column. Resume, "question N of M", the refresher, and the per-learner lock work as today, kept separately per mode.
   - Sessions serve due cards (`due <= now`), oldest due first, at most 5 items, one per card.
   - For each card the server picks a servable item of that concept and type:
     - first choice: a family the learner never answered, earliest cited second first;
     - otherwise: the family whose last attempt is oldest, labelled "You've seen this question before".
   - A card with no servable item is left unchanged and counted as `unavailable` in the response. There is no fabricated substitute.
   - The refresher stays available and is recorded as help, as today. A correct answer after it is therefore unrated.
6. **UI:** the Reviews page gets two modes, Mistakes (default, unchanged) and Scheduled.
   - The Scheduled tab shows only when the flag is on.
   - Scheduled reuses the existing question card and sidebar, with its own heading and a "Due for review" chip.
   - After an answer, the result shows the server-derived next due date, as a local date in the browser, or "Answered with help: not scheduled".
   - With nothing due, the empty state shows the next due date if one exists.
7. **Due entry:** "N reviews due", linking to the Scheduled mode, on the **My Learning overview**, shown only when N > 0. **This deviates from the plan's "home page"**: the public home is unauthenticated and shouldn't become per-user dynamic for this.
8. **Flag:** add `scheduled-review` (`FLAGS.scheduledReview`). It requires `review-session` and `learner-evidence`, and it is off until you create it in PostHog (our key is read-only).
9. **Out of scope** (plan-listed separate increments): email reminders, Hard/Easy ratings, FSRS parameter optimisation, and delayed-retention analytics.

## Expected files

- **New:**
  - `db/migrations/0004_review_cards.sql`;
  - `lib/review/rating.ts`, `lib/review/fsrs.ts` (the `ts-fsrs` adapter);
  - `lib/review/cards.ts` (card and log reads and writes);
  - `lib/learner/scheduled-review.ts` (planning and presenting);
  - their tests: `lib/review/*.test.ts`, `lib/review/cards.db.test.ts`, `lib/learner/scheduled-review.{test,db.test}.ts`, `lib/learner/scheduled-route.db.test.ts`.
- **Changed:**
  - `package.json` and `package-lock.json`: `ts-fsrs` pinned exactly to `5.4.2`;
  - `lib/learner/attempts.ts`, plus its call site `app/api/attempts/route.ts`;
  - `lib/learner/contracts.ts`: the optional `schedule` in the attempt result, a `mode` in the review request and response, the `scheduled_due` reason, and the none reason `nothing_due` with an optional `nextDueAt`;
  - `lib/learner/review-session.ts`: mode-scoped active-session lookup;
  - `app/api/review-session/route.ts`;
  - `sanity/queries/assessments.ts`: `type` added to the grading projection;
  - `sanity.types.ts`, via typegen;
  - `lib/learner/content*.ts`;
  - `lib/flags.ts`;
  - `app/my-learning/reviews/page.tsx`, `components/my-learning/reviews/*`, and `app/my-learning/page.tsx` for the due line;
  - the `lib/db/migrate.db.test.ts` expected list;
  - the truncate lists in the DB tests.

## Migration 0004 (additive)

- **`learner.review_card`:**
  - `id`, `learner_id`, `concept_id`, `task_type` (check in recall/apply/transfer), unique `(learner_id, concept_id, task_type)`;
  - the full `ts-fsrs` card state as typed columns (`due`, `stability`, `difficulty`, `elapsed_days`, `scheduled_days`, `learning_steps`, `reps`, `lapses`, `state`, `last_review`), with exact columns taken from the installed 5.4.2 `Card` type;
  - `algorithm_version` (`ts-fsrs@5.4.2`), `params_version`, `rating_policy_version`, `created_at`, `updated_at`;
  - an index on `(learner_id, due)`.
- **`learner.review_log`** (immutable):
  - `id`, `learner_id`, `card_id`, and a unique `attempt_id` referencing `attempt_log`;
  - `outcome` (check in `rated` / `unrated_assisted_correct`);
  - a `rating` smallint that is null exactly when unrated;
  - `previous_state jsonb`, `new_state jsonb`, `reviewed_at`;
  - the three version columns.
- **`learner.review_session`:** a new `mode` column (check in `mistakes` / `scheduled`, default `mistakes`), so existing rows stay Mistakes.
- **`learner.review_session_item`:** the `reason` check is replaced by a superset that adds `scheduled_due`.
- **Security:** RLS `own_rows` on both new tables. For `vertex_learner_app`: select, insert, and update on `review_card` (no delete); select and insert on `review_log`.
- **Rollback:** turn the flag off. Attempts then stop touching cards, and the Scheduled tab and due line disappear. The tables and constraint superset stay, and nothing is dropped. Applied to `vertex_local` only; never to Supabase or production without a separate yes.

## Requirements and security

- Identity comes only from `auth()`. The only client input is `mode`, which picks a list; the server chooses every card and item. There is no client-supplied rating, confidence mapping, due date, or card id.
- Every learner query goes through `asLearner`.
- `ts-fsrs` runs server-side only, and none of its state beyond the next due date reaches the client.
- There is no raw learner text anywhere, and no new analytics events.
- Timestamps are stored in UTC. Dates are formatted in the browser's time zone, and the server never computes "today".
- Existing Mistakes behaviour, `/api/attempts` responses with the flag off, and all current tests are unchanged.

## Acceptance

1. **Adapter fixtures** against the installed `ts-fsrs@5.4.2`:
   - first review, Good and Again;
   - Again then Good (relearning);
   - an overdue review;
   - two reviews on the same day;
   - these do **not** assert that every Good lengthens the interval.
2. **Rating table:** all four rows, plus a type-level check that self-confidence cannot reach the adapter.
3. **DB tests:**
   - the card is created or updated in the attempt transaction;
   - an idempotent replay adds no second log row;
   - concurrent submissions on two families of one card give two ordered log rows with consistent state;
   - a failure rolls back the attempt and the card together;
   - with the flag off, no card or log rows;
   - RLS: another learner can't read or write cards or logs;
   - assisted correct leaves the card state byte-identical (unrated log) and creates a New card when none existed.
4. **Scheduled session:**
   - only due cards;
   - an unseen family before a repeat;
   - a repeat is labelled;
   - a card without an item is `unavailable` and unchanged;
   - Mistakes and Scheduled sessions resume independently;
   - `nothing_due` carries the next due date;
   - a withdrawn item is `unavailable`.
5. **Mistakes mode:** its existing tests pass unchanged.

## Checks

- With nvm Node 22: `npm run typecheck`, `npm run lint`, `npm test` with `TEST_DATABASE_URL` (embedded Postgres, see memory), and `npm run build`.
- Apply `0004` to `vertex_local` only after the checks pass, then merge into `preview/my-learning` (local only) and restart just `next dev -p 3000`.

## Manual tests (they need at least one approved, published item with a `primaryConcept`; today there are 0)

1. With `scheduled-review` on for your id, open `/my-learning/reviews`: the Mistakes and Scheduled tabs are visible, and Mistakes is the default and unchanged.
2. On an auth-vs-authz lesson, start the check and answer Q1 correctly without hints. The result shows a next due date. Read-only SQL shows one `review_card` and one `rated` log with rating 3.
3. Answer another item of the same concept and type with a hint, correctly. The result says "not scheduled", and the log is `unrated_assisted_correct` with the card state unchanged.
4. To make a card due for the check, a test-only SQL update of `due` on `vertex_local` (documented, then reverted). Scheduled then serves it; answering updates it.
5. With the flag off, the Scheduled tab and due line are gone, and answering writes no card rows.

## Dependencies and stacking (verified 2026-09-14)

- **Base:** `feat/focused-review` `df9fc39` (local, not pushed) → #15 → #14 → #12 → #11 → #10 → #9 → #7 → #6 → #4.
- **Real imports:**
  - Focused review imports #15 modules;
  - #14 and #15 import nothing from PR-6: they need PR-4, and are stacked on draft #12 by construction only;
  - PR-7 (`3de183e`) calls `/api/tutor`, so it really needs #12.
- **PR-7 overlap:** PR-7 and Focused review both edit 10 files (`lib/flags.ts`, `lib/learner/{contracts,content,content-source,test-content}.ts`, `sanity/queries/assessments.ts`, `sanity.types.ts`, `lib/assessments/learner.ts`, `lib/lesson/{api,help-actions}.ts`). PR-9 edits several of the same files, so expect conflicts when stacking; `preview/my-learning` already resolves PR-7 + Focused review.
- **Branch plan:** a new worktree `../vertex-pr-9` on `feat/pr-9-scheduled-review` off `df9fc39`. Nothing is pushed and no PR is opened without your yes.

## Implementation notes (2026-09-14)

### Deviations from the plan above

- **A repeated question is rated by the help on its own task only.**
  - PR-4's help facts cover a family's whole history (`getFamilyHelpState`). So a scheduled repeat of any question the learner once had a hint on, or once saw the explanation for after answering, would count as assisted forever.
  - With sparse inventory, that card would then come round due, be answered correctly, stay unrated, and be due again, endlessly.
  - `submitAttempt` therefore uses the family's help for a first answer (the same facts as its evidence) and `getTaskHelpState` (all help on this task instance, the refresher included) for a repeat.
  - Mastery evidence is unchanged: a repeat is still `not_counted`.
- **Scheduled responses have their own schema** (`scheduledReviewResponseSchema`: `mode`, `unavailableDue`, `repeat` on open items, the `scheduled_due` reason, and up to 5 concepts). Mistakes responses and `REVIEW_REASONS` are byte-identical to before, so every Mistakes test passes unchanged.
- **`unavailableDue`** is counted only when a session is built; a resumed session reports 0.
- **`review_session_item`** also gains `card_id` (required exactly for `scheduled_due`) and `repeat`.
- **The due line** shows "Your due reviews couldn't be checked right now." on a failed read, never 0. A new component, `components/my-learning/due-reviews.tsx`.

### Results

- Tests: 630/630 with `TEST_DATABASE_URL` (embedded Postgres on :54329), including:
  - 7 adapter fixtures;
  - 3 rating tests;
  - 9 card DB tests (replay, concurrency, rollback via a failing trigger, and RLS);
  - 5 planner tests;
  - 7 scheduled-session DB tests;
  - 2 new route tests (flag gating, and `/api/attempts` writing cards only with the flag on);
  - 2 migration tests.
- Typecheck, lint, and `next build` pass.
- Worktree setup: `studio/.env` was copied from `../vertex-my-learning` (project id and dataset only) and `studio` got `npm ci` for typegen. `sanity.types.ts` changed only for `type` in the grading projection.
