# PR-12: Learner submission review

Status: the user asked for the implementation directly ("Proceed through implementation and verification. Resolve routine decisions independently and document material deviations."), which is the CLAUDE.md bypass for the approval step. This file is the decision record. It was not a pre-approved plan.

## Goal

A signed-in learner submits a code snippet for an eligible lesson and gets specific feedback on their own code: line references, the task criterion each finding concerns, related concepts and course moments, and help that increases only when they ask for it. They can then revise and resubmit. A correct implementation that differs from the instructor's code is not a defect.

## Branch and base

- Worktree `../vertex-pr-12`, branch `feat/pr-12-submission-review`, based on `feat/pr-7-lesson-integration` `3de183e`. That commit was already on GitHub inside `feat/pr-11-base`; the branch ref was pushed at it unchanged so the draft PR can target it. That commit contains PR-0 (`lib/ai/contracts.ts`, `gateway.ts`), PR-3 (concepts), PR-4 (learner evidence, `asLearner`), PR-5 (`help-policy.ts`), PR-6 (the tutor and its citation helpers), #14, and PR-7 (the lesson-page integration).
- `main` has none of these. PR-2 (visual index, `feat/pr-2-visual-index`) is **not** in this stack, so review evidence is **transcript-only**. There is no visual integration.
- PR-8, PR-9 and PR-11 are not required, and neither is the `tutor` flag.

## Guidance read

AGENTS.md; `docs/Vertex_AI_Native_Development_Plan.md` (§3, §5 PR-4/5/6/7/12, §6); the memory notes for PR-4 to PR-11. Code inspected:
- migrations 0001 and 0002, `lib/db/*`;
- `lib/learner/{contracts,http,help,help-events,evidence,task-instances,content*}.ts`;
- `lib/ai/{gateway,contracts,help-policy,tutor,tutor-support}.ts`, `lib/tutor/*`;
- `lib/evidence/chunks.ts`, `lib/lesson/*`, `components/lesson/*`, `app/lessons/[slug]/page.tsx`;
- the Studio schemas and publish gates, `sanity/queries/assessments.ts`;
- the route tests (`help-route.db.test.ts`) and the other branches' migrations and `help_event` readers.

## Content audit (read-only, production, 2026-09-14)

- 0 published assessments; 12 approved concepts, none for SQL injection.
- There is no submission task of any kind, and no schema for one.
- Lesson `practical-web-security-sql-injection` ("SQL injection", 254 s, video `video-youtube-AOXMDbc11AE`, 14 transcript chunks, no chapters) teaches:
  - that concatenating input into a query lets the input change the query;
  - that placeholders are defined first and values bound separately;
  - that this applies to insert, update and delete too.
- It is a narrated explainer with no on-screen code, but it states the rule a small coding task can check. It is the pilot lesson. The task is prepared as a **draft for editor review** (`docs/submission-review/`), never written to Sanity, and the implementation is verified against **synthetic fixtures**.

## Decisions

1. **Content model: a new `submissionTask` document.** It follows the `assessment` pattern: it references its lesson, and the lesson does not store it. The `assessment` type is single-choice throughout (options, answer key, hint ladder), and the lesson-check query would pick up any new assessment format, so reusing it would couple the two features. The fields are only those the task needs:
   - eligibility: `reviewStatus` plus review checks, published;
   - `title`, `instructions`, `language`;
   - `criteria[]`, where the criterion id is the array `_key`;
   - `concepts[]` (approved concepts), and `sourceChunkRefs[]` with chunk revisions;
   - `taskId` (stable) and `version`.
   Publishing is gated like concepts: every review check, `taskId` immutable, a new task at version 1, a content change requires exactly version + 1. Creation goes through `npm run draft:submission-task`, because source refs need server-resolved chunk revisions that an editor can't type. The Studio can't create or duplicate one.
2. **Eligibility.** The lesson is published, it has an approved published task (the first by `taskId`), and every source ref still matches its chunk's current revision. A stale ref hides the task and makes the route answer `task_unavailable`. This is how evidence staleness is detected; there is no generator to set a `sourceStatus`.
3. **No task instances.** `learner.task_instance` requires 3–4 delivered option ids. A code task pins nothing learner-specific, so the request names `{lessonId, taskId, taskVersion}`, and a version other than the current one gets 409 `task_unavailable`. *Deviation from the plan's `taskInstanceId`.*
4. **Help (PR-5 policy, unchanged).** Help is recorded as `help_event` rows:
   - `task_instance_id` is null;
   - `session_id = submission-review:<reviewId>`, the scope the policy counts levels in;
   - `family_id = submission-task:<taskId>`, the scope evidence counts assistance in, across versions;
   - `concept_ids` holds the task's concepts.
   Tutor session ids can't contain `:`, so these keys can't collide with them. A review with help-worthy findings is delivered at `decideHelpLevel({mode: 'study', request: 'hint'})`: level 1 for a new review, and the level already reached when the same review is shown again. "Explain the issues" is `escalate` (1→2). "Show corrections" is `solution` (→3, the explicit-answer escape hatch), which is recorded as answer exposure. A re-review, a retry, or an unchanged submission never escalates. *Changed during implementation from per-task-version scope; see the notes.*
5. **Generate once, disclose by level.** One model call returns every finding with a level-1 guiding question, a level-2 explanation, and a level-3 correction. The server stores all three privately and returns only the decided level, so more help needs no new model call. Level 1 shows the lines, the criterion, the question and the course moments; level 2 adds the explanation and the concepts; level 3 adds the correction.
6. **Finding categories:** `defect`, `requirement_mismatch`, `alternative_valid`, `uncertain`. The plan's `style_suggestion` is left out, to avoid nitpicks in V1. Each finding has lines, an optional criterion, concepts, and course citations.
7. **Server validation.** Before anything is stored:
   - line ranges must lie within the submission, with at most 40 lines each;
   - the model's `quote` must appear in the flagged lines (whitespace-normalized);
   - criterion ids must be the task's, and `requirement_mismatch` needs one;
   - concept ids must be the task's approved concepts;
   - passage ids must be the task's evidence passages, and a passage must share a content term with the finding.
   Anything invalid is dropped and counted, never repaired.
8. **A second, model-assisted check** (`review-check-v1`, PR-6's two-call pattern). It re-reads the code, the criteria and the findings. It confirms or rejects each defect or mismatch (an alternative correct implementation is rejected), confirms each "met" criterion, says whether each finding's cited passages support it, and flags a question that gives the fix away. The server then:
   - drops a rejected defect;
   - turns an unsure verdict into `uncertain`;
   - turns an unconfirmed "met" or an unsupported "not met" into `unclear`;
   - removes unsupported citations;
   - replaces a leaking question with a server-written one.
   This is not proof of correctness, and it is labelled provisional.
9. **Outcome.** The server derives it, never the model:
   - `cannot_judge` (with a reason) when the model can't judge;
   - `changes_suggested` for any defect or `not_met`;
   - `partly_judged` for any `unclear` or `uncertain`;
   - otherwise `no_issues_found`, shown as "no problems found against these criteria; a model's reading, not a test run". An empty list is never shown as "verified correct".
10. **Storage (migration `0006_submission_reviews.sql`).** 0003–0005 are taken on sibling branches, and the runner keys on the filename.
    - `learner.submission_review` is the cached analysis, one row per learner and `cache_key`. The key is the sha256 of task id, version, task hash (content, criteria, concepts, and chunk ids plus revisions), submission hash, review and check prompt versions, and model id. It is never shared across learners: `unique (learner_id, cache_key)` plus RLS.
    - `learner.submission_log` has one row per review request, with its idempotency key, request hash, content hash, line and character counts, cache hit, assistance classification, and help level before.
    - Both use `asLearner` and the RLS, grant and revoke block from 0002. `vertex_learner_app` gets select and insert, plus update only on the review's status columns.
    - **Raw code is not stored.** It goes only to the model provider. The analysis stores the model's questions, explanations and corrections, which may quote code, privately.
11. **Concurrency.** tx1 claims the review with a `pending` row (a claim token and a 90 s lease). The model calls run outside any transaction. tx2 completes the claim and records the log, the help event and the outbox events under `lockLearnerFamily`.
    - A concurrent identical submission gets 409 `review_in_progress` (retryable), and the client retries with the same key.
    - A provider failure marks the row `failed`, so the next try re-evaluates, and records no submission or help.
    - Same key with a changed body gets 409 `idempotency_key_reused`; a replay returns the stored result.
    - There is a budget of 20 model evaluations per learner per hour. Cache hits and help requests are free.
12. **Evidence.** Each submission is classified in `submission_log`:
    - identical content submitted before → `not_counted` / `repeat_submission`;
    - any recorded help on the task → `assisted` (`hint_used` or `answer_exposed`);
    - an earlier, different submission → `not_counted` / `repeat_task`;
    - otherwise → `independent` / `first_independent_response`.
    **Nothing writes `concept_mastery`.** An AI review, or a lack of findings, is never mastery.
13. **Flags.** A new `submission-review` flag, plus `learner-evidence` (the tables) and `help-policy` (the ladder is the PR-5 policy). It does **not** need `lesson-integration` or `tutor`: the lesson page resolves the task separately from `resolveLessonFeatures`. All flags fail closed. The flag does not exist in PostHog and must be created by the user.
14. **API.** `POST /api/review`, with a strict discriminated body:
    - `{action: 'review', lessonId, taskId, taskVersion, submission: {type: 'snippet', content}, requestKey}`;
    - `{action: 'help', reviewId, request: 'escalate' | 'solution', requestKey}`.
    Help needs the review's task hash to still be current. There is a 48 KiB body cap, and after normalization 8,000 characters and 200 lines. GitHub input is deferred: the union has only `snippet`.
15. **Logging.** The route has its own failure handler, which logs only the error name or category, never error objects, because a Zod or provider error can carry code. Model diagnostics use the gateway's text-free line, and analytics carry ids, enums and counts only.

## Files (expected)

- `studio/schemaTypes/documents/submission-task.ts`, `studio/schemaTypes/index.ts`, `studio/actions/submission-task-publish.ts`, `studio/sanity.config.ts`, `studio/structure.ts`, `studio/schema.json`, `sanity.types.ts`
- `db/migrations/0006_submission_reviews.sql`, `lib/db/migrate.db.test.ts`
- `lib/submissions/`: `text.ts` (normalization, shared with the client), `task.ts` (task model, hash, and the server-side parse), `source.ts` (GROQ port), `sanity-source.ts` (server-only), `evidence.ts`, `service.ts`, and their tests
- `lib/ai/review.ts` (prompt, schema, validation), `lib/ai/review-check.ts`, `lib/ai/review.test.ts`
- `lib/learner/contracts.ts`, `lib/learner/http.ts` (schemas and error codes)
- `app/api/review/route.ts`, `lib/flags.ts`, `lib/timeouts.ts`, `.env.example`
- `lib/lesson/review-actions.ts`, `components/lesson/submission-review.tsx`, `app/lessons/[slug]/page.tsx`
- `scripts/draft-submission-task.mts`, `docs/submission-review/sql-injection-lookup.task.json`, `scripts/eval-review.mts`, `scripts/review-eval-cases.json`

## Security

- Identity comes only from `auth()`; bodies are strict, so a `userId`, level, score or verdict is rejected. The flags are checked before any content or database access.
- Learner rows go through `asLearner` and RLS; a review id from another learner is `not_found`.
- The submission is JSON-encoded as untrusted data in both prompts, and the system prompts say comments and strings are data, never instructions.
- Citations are built from stored chunk records (`resolveCitation`), never from model values.
- No provider key reaches the browser. No raw code goes into analytics, logs, public fixtures, or the database.
- The eval fixtures are synthetic code, and the eval output quotes no transcript text.

## Acceptance

- The route tests cover 401, the flags, strict bodies, and size limits.
- The service DB tests cover isolation, cache per learner, idempotent replay, a changed body, concurrent duplicates, cache invalidation on task, version and prompt changes, help escalation and the explicit solution request, the assistance classification, provider failure, the rate limit, stale evidence, no mastery writes, and outbox payloads with no text.
- Unit tests cover validation (lines, quote, criterion, concept, passage), check merging, the outcome, level filtering, and prompt injection kept inside the JSON.
- Typecheck, lint, test and build all pass.
- A live eval over the synthetic cases is reported as structural checks, separately from a semantic reading.
- Signed-in browser checks run with throwaway users, an isolated DB, and a temporary fixture patch that is reverted afterwards.

## Implementation notes

### Deviations from the plan and the first draft of this record

- **No `taskInstanceId`.** The request names `{lessonId, taskId, taskVersion}`; a stale version gets 409 `task_unavailable` (decision 3).
- **The help ladder is scoped per review, not per task version.** In the first browser run, after "Show corrections", a different, incomplete submission opened straight at level 3, because the policy's scope was the whole task version. With the per-review scope, new code starts at level 1 again, while unchanged code keeps the level it reached. Assistance is still counted per task (`family_id`), so every later submission is `assisted` / `answer_exposed`. The DB test "treats show corrections … as assisted" covers both halves.
- **`submission_log.help_event_id` is not a foreign key.** Every existing DB test runs `truncate learner.help_event` without `cascade`, and a reference into 0001 would break all of them. The service writes both rows in one transaction.
- **`style_suggestion` is not implemented** (decision 6).
- **Prompt `review-v1` → `review-v2`.** Eval run 1 showed the same bug reported as both a `defect` and a `requirement_mismatch` (three cards for one problem), and "valid alternative" notes on ordinary code. `review-v2` reports each problem once, as its criterion's mismatch, and keeps `alternative_valid` for a different library or syntax only. Run 2 is on `review-v2`.
- **No concept is linked on the pilot task.** No approved concept covers SQL injection, and the draft script refuses unapproved ones. Concept display and validation are exercised by fixtures only.
- **The task is not published.** `docs/submission-review/sql-injection-user-lookup.draft.ndjson` (`drafts.submissionTask-sql-injection-user-lookup`, `needs_review`, every review check unticked) was generated read-only by `npm run draft:submission-task` and was never imported.

### Verification (2026-09-14)

- Automated:
  - `npm test` **634/634** with `TEST_DATABASE_URL` on an isolated embedded Postgres (:54334, this session's scratchpad), including `migrate.db.test.ts` with 0006;
  - `npm run typecheck` and `npm run lint` clean;
  - `npm run build` passes (`/api/review` dynamic);
  - studio `npm run typecheck` and `sanity schemas validate` (0 errors, 0 warnings).
  - The base `3de183e` had 565/565 before any change.
- Tests added:
  - `lib/ai/review.test.ts` (28): prompt isolation, every deterministic gate, check merging, outcomes, level disclosure, text-free diagnostics;
  - `lib/submissions/submissions.test.ts` (12): normalization, evidence classes, strict request, GROQ source staleness and hash, eval-case shape;
  - `lib/submissions/service.db.test.ts` (22): isolation and RLS, replay, changed body, cache reuse and three identical submissions, cross-learner cache, escalation, explicit override, assisted classes, cannot-judge, invalidation on task, version and model, stale or missing task, input limits, provider failure and retry, no provider, budget, concurrent claims, lease takeover, key reuse, and no code stored or in the outbox;
  - `lib/submissions/review-route.db.test.ts` (7): the real route, covering 401 before flags, 404 per flag combination with no access, strict and bounded bodies, 201/200 replay/help, 503 with no code in logs, and a retryable 409.
- Live evaluation, **structural only** (`npm run eval:review`, the draft task on the live published lesson, 7 chunks resolved at matching revisions, 11 synthetic cases or 12 steps, because `fixed-after-feedback` has two; 23 calls per run, because the Python case needs no check call):
  - run 1 (`review-v1`): 12/12;
  - run 2 (`review-v2`): 12/12.
  Reports are in `docs/evals/pr-12-review-eval-run-{1,2}.md`, with no transcript text. **0/11 cases have been read by a person**, so semantic quality is not established; see the limitations below.
- Signed-in browser checks on `next dev -p 3012`:
  - Setup:
    - the isolated DB `vertex_pr12_dev` (dropped afterwards), production Sanity read-only;
    - two temporary env-guarded patches, reverted and checked with `shasum` against copies: one forced the three flags, one served the unpublished draft as the lesson's task;
    - PostHog blocked: the server host pointed at `127.0.0.1:9`, and the page's `/ingest` requests failed in Chrome;
    - four throwaway Clerk dev users, each deleted, with sessions revoked and rows deleted.
  - Signed out: no task section; the API returns 401.
  - Signed in:
    - the task and criteria render; the in-progress state shows;
    - level 1 shows lines 2 and 3 flagged, questions, and grouped timestamp citations (`1:04–2:50`, with the `?t=` href kept);
    - a citation click seeked in place, with no navigation;
    - level 2 adds explanations, and level 3 adds corrections;
    - a forced 503 kept the code in the field and offered "Try again", which then reviewed it;
    - the corrected code gives "No problems found…" plus "counts as assisted practice";
    - the incomplete code gives "Partly reviewed";
    - new defective code after corrections opens at level 1 (per-review scope);
    - a forged `userId` gets 400;
    - at 390 px there is no horizontal overflow;
    - another learner using the first learner's review id gets 404.
  - DB after the flow:
    - evidence `independent` → `assisted`/`answer_exposed` ×2 → `not_counted`/`repeat_submission`;
    - help levels 1, 2, 3 and repeats, 0 `concept_mastery` rows;
    - the full submission text is not stored. The only learner line found was `return result.rows[0] ?? null`, inside a model-written correction.
  - Flags off (fail-closed; the real PostHog evaluation of `submission-review` is `false` because the flag doesn't exist): no task section, the API returns 404, and nothing is written.
- Not verified:
  - Supabase: migration 0006 was applied to local Postgres only;
  - the real flag targeting;
  - the Studio publish gate in a running Studio (typecheck and schema validation only);
  - the content of analytics payloads: they were blocked and not decoded; the capture calls pass ids, enums and counts only (`components/lesson/submission-review.tsx`);
  - a human reading of the eval cases;
  - the task in production, which is unpublished.

### Evaluation limitations (semantic reading by Claude, not a reviewer)

- All 12 steps reached the intended outcome on the synthetic set:
  - it caught concatenation, template strings, and manual escaping;
  - it accepted node-postgres, better-sqlite3, mysql2, postgres.js tagged templates, and Knex, with no defect on any alternative;
  - it said "unclear" for the helper it couldn't see;
  - it resisted the comment injection;
  - it found the `undefined` vs `null` mismatch without a course citation;
  - it returned "cannot judge" for Python.
- Problems found in the run-2 feedback text (addressed in follow-up 1, below): none makes a structural check fail.
  - **Level-3 corrections can switch away from the learner's driver** (run 2: `manual-escaping` and `fixed-after-feedback` step 1). For example, a node-postgres submission got a mysql2 `db.execute` correction, which would break if applied as written. In `helper-not-shown` the corrections mix three drivers.
  - The check over-flags leading questions as giving the fix away (run 1: 4, run 2: 1). The server's generic fallback, which quotes the whole criterion, is less useful than the question it replaces.
  - One alternative note says the lesson shows specific drivers. It shows none, only a generic `?` placeholder.
  - One problem that fails two criteria becomes two cards.
  - One uncertain note (the `[rows]` result shape) is inconsistent: the same shape passed in step 2 and in run 1.
- The check is a filter, not a second reviewer:
  - It can drop or downgrade what the first call reported, and refuse to confirm a "met", but it cannot add a finding the first call missed.
  - If only the first call is talked out of reporting a real problem, the outcome falls to `partly_judged`: the criteria are marked unclear and no finding explains why. This is unit-tested, and the UI copy covers the no-findings case.
  - The result is `no_issues_found` only if the check also confirms every criterion is met. Both calls read the same submission, so an injection that fooled both would pass. In the one live injection case, both calls resisted.
- The set is small, synthetic, and single-task. The model is not deterministic, and each case ran twice at most. Nothing here shows the quality on real learner code, other languages, or longer submissions. Keep `submission-review` off until a person has read the cases and a reviewed task is published.
- Latency: 3–15 s per call, and up to about 28 s for the two calls together (run 1, injection case). The UI says it can take up to a minute. The route has no platform `maxDuration`.

### Integration notes (for the integration session; nothing was merged)

Trial merges in a throwaway detached worktree:
- **`preview/my-learning`**: conflicts in `lib/flags.ts`, `lib/db/migrate.db.test.ts`, `package.json`, `studio/sanity.config.ts`, `studio/structure.ts`. All are additive lists; keep both sides.
  - `migrate.db.test.ts`: `TABLES` gains `submission_review` and `submission_log`, `MIGRATIONS` gains `0006_submission_reviews.sql` after 0003–0005, and `granted` gains both entries plus the column checks.
  - `sanity.types.ts`: add PR-12's delta by hand and don't regenerate the whole file. The preview's copy carries PR-2 and PR-11 types by hand, and this stack has no PR-2 schema. The delta is the `SubmissionTask` type, `ConceptReference` (moved, not changed; keep one copy), and `| SubmissionTask` in `AllSanitySchemaTypes`. No PR-12 code imports these generated types.
- **`feat/pr-11-next-action`**: `lib/flags.ts` and `migrate.db.test.ts`, as above.
- **`feat/pr-9-scheduled-review`**: the same two, plus PR-7's own `lib/learner/content*.ts` and `test-content.ts` conflicts, which the preview already resolved.
- **`feat/pr-2-visual-index`**: `.env.example`, `lib/flags.ts`, `package.json`, and the two studio files, all additive.
- The PR-12 DB tests truncate only tables that nothing in 0003–0005 references, so they need no edits after the merge.
- Migration order: 0006 applies after whatever of 0003–0005 exists.

## Follow-up 1: feedback defects (implemented 2026-09-14)

Requested 2026-09-14 after the first audit. The user approved this plan with limits, quoted: "Keep driver validation limited to the affected evaluation fixtures, and reuse existing dependencies where possible. Do not build a general-purpose code execution system. Run correction fixtures only in an isolated test environment. Treat the new server check as a guard, not proof of correctness. Concept calls are dry-run preparation only; no automatic approval or publishing." PR #17 stays a draft, and `submission-review` stays off. The plan below is as approved; the results and deviations follow it.

### Defects to fix (observed in run 2)
1. **Incompatible driver corrections: functional errors.**
   - `manual-escaping`: node-postgres code (`db.query`, `result.rows`) got a mysql2 `db.execute` / `[rows]` correction.
   - `fixed-after-feedback` step 1: mysql2-shaped code (`[rows] = await db.query`) got a node-postgres `$1` / `res.rows` correction.
   - `helper-not-shown`: no driver is visible, yet the corrections invented code for three different drivers.
2. **An unsupported course claim.** The `postgres-js-tagged-template` note says "the drivers shown in the lesson passages". The lesson shows no driver.
3. **The check over-flags leading questions** (5 across both runs), so the server's generic fallback replaces useful hints.
4. **An inconsistent uncertain note** about the `[rows]` result shape (`fixed-after-feedback` step 1). The same shape passed in step 2 and in run 1.
- Not in scope: the double card for one problem failing C1 and C2 is a rubric question, left to the task review (merge C1 and C2, or keep both).

### Changes
- **Review prompt `review-v3`** (`lib/ai/review.ts`):
  - A correction must keep the submission's own driver conventions: the same client, methods, result shape, and placeholder style its code already uses. It must never switch driver or library.
  - If the submission shows no driver-specific call (for example, the query runs in a helper that isn't shown), the correction is prose only. It says what must change and asks for the missing code or the driver name. No snippet.
  - Never say what the lesson, course, or passages show beyond what a cited passage states.
  - Don't raise uncertainty about which driver is used when the code's calls and result handling are consistent with each other.
- **Deterministic gate 4, correction conventions** (`lib/ai/review.ts`; new `DropReason 'incompatible_correction'`):
  - It reads the submission's conventions from its code: methods called on the client (`query`, `execute`, `prepare`/`get`/`all`/`run`, a tagged template, a builder call), the result access (`.rows`, or array destructuring of an awaited call), and the placeholder style when the submission has placeholders.
  - It replaces a correction when that correction:
    - calls a client method the submission doesn't use;
    - reads the result the other way (`.rows` against `[rows]`);
    - uses a different placeholder style from the submission's own;
    - or contains executable client calls when the submission establishes no driver.
  - The replacement is qualified guidance written by the server, never code. For example: "Keep the `db.query` call and the result handling you already use; change line N so it meets “…”". When no driver is visible, the guidance asks for the query code or the driver name.
  - It is conservative: a valid same-driver switch, such as mysql2 `query` → `execute`, is also replaced by guidance. That errs toward no code, never toward broken code.
- **Check prompt `review-check-v2`** (`lib/ai/review-check.ts`):
  - A new `correctionCompatible` field per finding: true when the correction has no code, or its code uses the submission's own driver, API and result shape. When it is false, the server replaces the correction the same way.
  - `questionRevealsFix` is narrowed: true only when the question names the fix, such as the placeholder, bound values, or a specific API or code change. Asking what a value evaluates to is not revealing.
  - `sourcesSupport` becomes false when the explanation claims the course or passages show something they don't.
- **Alternative notes:** an `alternative_valid` explanation that refers to the lesson, course, passages or video is replaced by the server's neutral text ("A different library or syntax that still meets the criterion"), so no course claim reaches the learner.
- **Help and assistance records:** unchanged. Level 3 still shows the (possibly server-replaced) correction, and `solution` is still recorded as answer exposure. That is conservative: it may overstate assistance, never understate it. "Show corrections" stays offered.
- **Cache:** the prompt and check versions are already in the cache key, so every stored review from `review-v2`/`review-check-v1` is re-reviewed on the next submission.

### Regression cases
- Deterministic unit tests (`lib/ai/review.test.ts`):
  - replay the two observed incompatible corrections through gate 4 and assert they are replaced, while the compatible C1 corrections in the same reviews are kept;
  - replay `helper-not-shown` and assert prose guidance only;
  - replay the postgres.js note and assert the neutral text;
  - test convention extraction for node-postgres, mysql2, better-sqlite3, postgres.js and Knex;
  - test `correctionCompatible: false` handling.
- Eval expectation `correction: {forbid[], require[]}` (`lib/submissions/eval-check.ts`). It checks each delivered correction as text, independently of gate 4:
  - `manual-escaping` forbids `execute(`, `[rows]`, `.get(`, and requires `.query(`;
  - `fixed-after-feedback` step 1 forbids `.rows` and `$1`;
  - `helper-not-shown` forbids any `db.<method>(` call.
- Two new focused eval cases:
  - `pg-template-literal`: a node-postgres `client.query` template string with `res.rows`;
  - `mysql2-execute-concatenation`: mysql2 `[rows] = await db.execute("…" + username …)`.
  Both carry forbid/require expectations.
- The eval report also counts gate-4 and check replacements per step, so it shows how often the model itself still gets this wrong.

### Driver verification in an isolated fixture (no learner code in the app; as planned, see the deviations)
- The devDependencies `pg`, `@types/pg`, `mysql2` (ships its types) and `@types/better-sqlite3` are added (`package-lock.json` changes).
- A typed fixture (`lib/submissions/driver-fixtures.ts`) holds a reference fix per driver, plus the rerun's delivered corrections copied in as static code after I read them. Each is typed against the real client types, and `npm run typecheck` rejects, for example, `execute` on a `pg` client.
- A DB test runs the node-postgres reference fix and each delivered node-postgres correction for real, with `pg`, against the embedded test Postgres. An injection payload must return `null` and a real username its row.
- mysql2 and better-sqlite3 are checked by types only: there is no MySQL server here (Docker is broken), and better-sqlite3 is a native addon. The fixture never evaluates text dynamically.

### Reruns (live model calls: 18)
- `npm run eval:review -- --case` gains comma-separated ids.
- Rerun 9 steps × 2 calls = 18 calls:
  - the affected cases: `manual-escaping`, `fixed-after-feedback` (2 steps), `helper-not-shown`, `postgres-js-tagged-template`, `returns-undefined`;
  - `injection-in-comment`, as a regression for the prompt change;
  - the 2 new cases.
- The other 5 steps are left as stored `review-v2` results, labelled as such (not representative of `review-v3`). Rerunning them would cost 10 more calls, only on request.

### Option B concepts (live model calls: about 2)
- The lesson evidence supports both concepts: SQL injection at 1:04–1:40 (`tc-64-3`, `tc-82-4`), and parameterized queries at 0:27 and 1:40–2:35 (`tc-27-1`, `tc-100-5` … `tc-155-8`). No approved concept fits: least privilege is the lesson's third key point, not what the task checks. No concept generation record exists for this lesson.
- Run `npm run generate:concepts -- extract --lesson practical-web-security-sql-injection --dry-run --out docs/evals/local/…`. That is the PR-3 pipeline, including its reuse and dedupe against existing concepts. It is a dry run and writes nothing to Sanity. The output holds source excerpts, so it stays gitignored.
- The packet presents each candidate, paraphrased without quoting the transcript. For each one it gives reuse or add, and a criterion → concept mapping: C1 → SQL injection and parameterized queries; C2 → parameterized queries; C3 → none. The task stores concepts at the task level.
- Nothing is created, imported, approved or published. Concepts must be approved before task v1 can reference them.

### Review packet
Rebuilt with per-step provenance: fresh run 3 or stored run 2. Three separate sections:
- **automated verification**: structural, correction forbid/require, gate counts, and the driver fixture;
- **AI assessment**: Claude's reading;
- **pending human review**: the unticked boxes.

The old sentence "the only correctness problems are in text" is removed: the driver switches were functional errors.

### Generated types: technical debt
- The preview's `sanity.types.ts` is hand-carried: PR-2 and PR-11 types are not reproducible by a full `npm run typegen` there, and that has not been verified. PR-12's hand-added delta is a stopgap, not the fix.
- This is recorded under "Technical debt" here and in the PR #17 body.
- Proposed to vertex-ff (the integration session): on the preview, register every merged schema type in `studio/schemaTypes/index.ts`, run the full typegen once, diff it against the hand-carried file, and commit when they match.

### Checks
Typecheck, lint, unit and DB tests, and build. The reruns above. No change to localhost:3000, the preview, flags or Sanity content.

### Follow-up 1 results

**Deviations from the plan above:**
- **Dependencies:** only `pg` and `@types/pg` were added, as devDependencies, following the user's instruction to reuse existing dependencies where possible.
  - mysql2 is type-checked in a throwaway scratch environment outside the repo (mysql2 3.24.4, strict `tsc`), not as a repo dependency.
  - better-sqlite3 is not checked: no affected case uses it.
- **Fixture:** it is one DB test, `lib/submissions/driver-fixtures.db.test.ts`, holding static copies of the affected node-postgres corrections. There is no typed `driver-fixtures.ts` module.
- **The server check** lives in `lib/ai/review-conventions.ts`, as gate 4. It is a lexical guard over the pilot drivers' methods (`query`, `execute`, `prepare`, `get`, `raw`, `unsafe`, `first`, `where`, `select`), result access and placeholder family. It is not proof that a correction works.
- **Incompatible corrections are replaced, not dropped:** the server writes guidance in words, so level 3 still shows something. When the submission shows no driver, the guidance asks for the query code or the driver name.

**Automated checks:**
- 652/652 tests pass (DB tests on an embedded test Postgres). Typecheck and lint are clean.
- New tests:
  - `review-conventions.test.ts`: the conventions of the five drivers, and the two observed run-2 incompatible corrections replayed verbatim;
  - gate-4 and check-field cases in `review.test.ts`;
  - the correction forbid/require expectation in `submissions.test.ts`;
  - the node-postgres driver fixture (3 tests).

**Live run 3** (`review-v3` / `review-check-v2`; `docs/evals/pr-12-review-eval-run-3.md`): 8 cases, 9 steps, 18 calls.
- 9/9 structural checks pass, and the 5 driver-regression steps pass their correction text checks.
- The server check replaced nothing: every correction the model delivered kept the learner's driver.
- Replayed offline, gate 4 would have replaced the run-2 functional errors (`manual-escaping`, `fixed-after-feedback`), the run-2 mixed-driver correction (`injection-in-comment`), the invented code in `helper-not-shown` (runs 1 and 2), and run 1's `fixed-after-feedback` correction, which my first audit had missed.

**Driver fixtures:**
- The run-3 node-postgres corrections, with the real `pg` driver against a disposable database, find the row, and return null for no match and for injection payloads.
- The run-2 mysql2 correction on a `pg` client throws `TypeError`.
- mysql2 types: the run-3 corrections compile; the run-2 `res.rows` correction does not.

**Concept dry run** (2 calls, nothing written; checked afterwards: 16 generation records, no concept document):
- The PR-3 pipeline proposed one new concept, `cpt-parameterized-queries`, and no separate SQL injection concept, although the lesson defines SQL injection at 0:47.
- No existing concept is reused.
- The proposal and mapping (C1 and C2 → `cpt-parameterized-queries`, C3 → none) are in the packet, pending the user. Nothing is imported, approved or published.

**Observations for the human review** (AI assessment, in `docs/evals/pr-12-review-packet.md`):
- The narrowed `questionRevealsFix` rule let one C1 question through that names the fix ("…or use a placeholder/bound value?"). The placeholder is in C2's visible text.
- mysql2 `query()` with `?` is escaping done by the driver, not a server-side bound parameter (confirmed in the mysql2 source). The review and the corrections accept it; the rubric decision is the user's.
- The `helper-not-shown` guidance is code-free but clumsy.
- The C1 and C2 cards still repeat the same fix.
- 5 steps are stored `review-v2` results, not re-run.

### Technical debt: generated Sanity types
- **Problem:** `sanity.types.ts` on the integrated preview (`preview/my-learning`) is maintained by hand. It carries PR-2 and PR-11 types that a full `npm run typegen` there is not known to reproduce; that is unverified. PR-12's delta (the `SubmissionTask` type, one `ConceptReference`, and the union entry) is added by hand as a stopgap. That is not the permanent solution.
- **Durable fix,** proposed to the integration session (vertex-ff), 2026-09-14:
  1. register every merged schema type in `studio/schemaTypes/index.ts` on the preview;
  2. run the full `npm run typegen` (schema extract, then generate);
  3. diff the result against the hand-carried file, and commit it if they match;
  4. otherwise, fix at its source any type that has no schema or query behind it.
- **Owner:** the integration session and its user. PR-12's code imports none of these generated types, so nothing depends on it.

