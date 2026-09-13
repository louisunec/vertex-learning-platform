# PR-5: Explicit help policy for reviewed assessment tasks

## Goal

Implement the fifth increment of `docs/Vertex_AI_Native_Development_Plan.md` (§5 PR-5): a server-side, versioned policy that decides how much help a learner gets on a task, and delivers the reviewed offline hint for that level.

- A pure `decideHelpLevel` covers all five precedence rules.
- `POST /api/help` applies it to PR-1's reviewed hint ladder for a PR-4 task instance, and persists a `help_event` and a `help_level_decided` outbox event.
- The level is decided and recorded server-side and then read by PR-4 grading, so assisted and exposed responses can never count as independent evidence.
- Behind a new flag `help-policy`, plus PR-4's `learner-evidence`. No UI (PR-7), and no model calls (PR-6).

Branch `feat/pr-5-help-policy`, worktree `../vertex-pr-5`, based on PR-4 `5f9f381` (#10). The PR base will be `feat/pr-4-learner-evidence`.

## Guidance read

- `AGENTS.md` §2, §3 (a new public API that is security-sensitive), §9, §11–§13; `CLAUDE.md` approval rules.
- Development plan §3, §4 (flags and dependencies), and §5 PR-1 (hint ladder), PR-4, PR-5, PR-6 and PR-7 for the boundaries.
- `prompts/pr-4-learner-evidence.md`, including its RLS amendment.
- Memory:
  - Supabase and PostHog flags, with sign-in required;
  - learner queries only through `asLearner`;
  - the Docker test Postgres;
  - Node 22 via nvm.

## Code inspected (at `5f9f381`)

- **Studio assessment schema:** `hints.{direction, keyConcept, solution}`. Levels 1–2 are validated not to reveal the answer. `solution` "identifies the correct option". The answer key is `answerKey.{correctOptionId, correctReason}`.
- **`sanity/queries/assessments.ts`:** the servable predicates, and `GRADING_ASSESSMENT_QUERY`, which is server-only.
- **`lib/learner/help-events.ts`:**
  - `recordHelpEvent`: idempotent by `request_key`, family taken from the instance, running in its own `asLearner` transaction;
  - `getFamilyHelpState`, which grading uses.
- **`lib/learner/attempts.ts`:** grading takes `pg_advisory_xact_lock(learner:family)`, and `classifyEvidence` turns level ≥ 3 into `answer_exposed` and level ≥ 1 into `hint_used`. The attempt response deliberately withholds the correct option and defers to "a level-3 help action (PR-5)".
- **`lib/learner/{task-instances,contracts,http,content,content-source}.ts`:** instance ownership, strict contracts, the bounded body, error mapping, and the content port.
- **`db/migrations/0001_learner_evidence.sql`:**
  - `help_event` has `task_instance_id`, `family_id`, `concept_ids`, `level 0–3`, `explicit_override`, `policy_version`, `reason_code`, `request_key` (unique per learner). It has no `mode` column.
  - `vertex_learner_app` already has `SELECT, INSERT` on `help_event` and `INSERT` on `event_outbox` (with its own `learnerId`), so **no grant or migration change is needed**.
- **`lib/flags.ts`, `app/api/attempts/route.ts`:** the route pattern (`auth()`, then flag, then bounded strict body, then service, then `failureResponse`).
- **`lib/ai/`:** the gateway and contracts. PR-5 calls no model.

## Decisions (recommended defaults, for approval)

1. **Scope split with PR-6.**
   - `lib/ai/help-policy.ts` holds the complete pure `decideHelpLevel`, covering all five rules and table-tested. The plan's `helpPolicy.ts` is renamed to the repo's kebab-case.
   - PR-5 wires only **known assessment tasks** with reviewed offline hints.
   - Rule 2 (an ambiguous request → level 0 with one clarifying question) has no input on this path, because the requests are structured choices. It stays in the policy and its tests for PR-6's free-text tutor, and the route never produces it.
   - PR-5 makes **zero** OpenAI calls.
2. **The policy:** `decideHelpLevel({mode, request, currentLevel, ambiguous?}) → {level, reasonCode, explicitOverride, policyVersion: 'help-v1'}`, applying these rules in precedence order:
   1. `mode === 'reference'` or `request === 'solution'` → level 3.
      - `explicitOverride = true` when this jumps past the next step.
      - Reason `reference_mode` or `explicit_solution`.
   2. `ambiguous` → level 0 (`clarification_needed`). PR-6 only.
   3. `request === 'hint'` with no prior help on the instance → level 1 (`first_help`).
      - A repeated `hint` re-shows the current level (`repeat_current`). It never escalates without an explicit request.
   4. `request === 'escalate'`:
      - with no prior help → 1;
      - after 1 → 2;
      - after 2 → 3 (`escalation`);
      - at 3 → stays 3 (`already_at_solution`).
   5. A solution request goes straight to 3 (covered by rule 1), not to `previous + 1`.

   Mastery is advisory only and never withholds help, so the policy takes no mastery input and the route reads none. Nothing speculative is built.
3. **Route: `POST /api/help {taskInstanceId, mode: 'study'|'reference', request: 'hint'|'escalate'|'solution', requestKey}`.**
   - Strict Zod, at most 2 KB, and **no `level` field**.
   - `mode` and `request` are the learner's own choices of how much help they want. The plan lets reference users ask for the answer directly. They can only *increase* the recorded assistance, which lowers the evidence class, so accepting them is safe.
   - A level, a history or a "no hints used" claim is server state and is rejected by the strict schema.
   - The response is `{helpEventId, level, reasonCode, policyVersion, hint: {level, text, correctOptionId?}, replayed}`. It carries **only the decided level's text**, never a lower or higher rung.
     - `correctOptionId` appears at level 3 only (Decision 6).
     - The response never includes `correctReason` or `distractorReasons`.
   - `Cache-Control: no-store`.
4. **Hint source.**
   - A new server-only `HINT_LADDER_QUERY` selects `hints.direction/keyConcept/solution` for one assessment, under the same servable predicates as `GRADING_ASSESSMENT_QUERY` (approved, current, published, lesson published).
   - It is parsed by a strict `hintLadderSchema` in `lib/assessments/hints.ts` that is never part of a response type. Only the chosen string is copied out.
   - The item must still match the instance's delivered version (family and version), as in grading.
   - A missing, stale, withdrawn or mismatched item, or an empty rung, returns `409 hint_unavailable`. **Nothing is recorded** (no help was shown), and no hint is ever fabricated.
5. **Progression scope vs evidence scope.**
   - Escalation is per **task instance** ("a new task starts its own sequence"). `currentLevel` is the maximum `help_event.level` on that instance, read by a new instance-scoped helper.
   - Evidence taint stays per **family** (PR-4 `getFamilyHelpState`, unchanged). A learner who saw the solution on one instance can start a new instance's ladder at 1, but any answer to that family already counts only as `not_counted`/`assisted`.
   - Level 3 delivers `hints.solution`, which identifies the correct option, so it is recorded as answer exposure for the family. `classifyEvidence` already maps this.
6. **Help after answering.** `/api/help` is allowed on an already-submitted or expired instance the learner owns. This is the only way a learner learns why an answer was wrong.
   - Expiry blocks submission, not help.
   - The help is recorded as usual, and it cannot change the stored grade or evidence class.
   - **Decided by the user (2026-09-13):** a level-3 response also includes the structured `correctOptionId`, so PR-7 can highlight the option without parsing text. Levels 0–2 never include it, and `correctReason` and the distractor reasons stay private.
     - The hint query and `hintLadderSchema` therefore also select `answerKey.correctOptionId`.
     - The response's `hint` becomes `{level, text, correctOptionId?}`, and a contract test asserts `correctOptionId` is absent below level 3.
7. **Concurrency and retries: one transaction per request.** `requestHelp` runs inside `asLearner`:
   1. `pg_advisory_xact_lock(learner:family)`: the same key as grading, so help and grading on one family serialize.
   2. Replay by `request_key`. A stored event returns its original level and text, and `replayed: true`.
   3. Load the owned instance (404 otherwise).
   4. Read `currentLevel`.
   5. Decide.
   6. Insert `help_event`.
   7. Insert the `help_level_decided` outbox row.

   The Sanity hint read happens before the transaction, keyed by the instance's assessment id. The instance is looked up in a first scoped transaction, as in grading.

   `recordHelpEvent` is refactored to take a transaction so the decision and the insert are atomic.
   - A same-key retry never escalates, which PR-4 already tests.
   - Two different-key `escalate` clicks serialize to 1→2 then 2→3. Without the lock, both could read the same level.
8. **Storage and outbox.**
   - `mode` is folded into `reason_code` (`reference_mode`) instead of a new column, so there is no migration.
   - `help_level_decided` payload: `{helpEventId, learnerId, taskInstanceId, familyId, level, reasonCode, explicitOverride, policyVersion}`. Ids and enums only, never hint text.
   - As #10 documents, there is **no outbox dispatcher**. The event is written and stays `pending`.
9. **Flag and dependency.**
   - `FLAGS.helpPolicy = 'help-policy'`.
   - The route requires **both** `learner-evidence` and `help-policy` on for the user; otherwise 404 before any database or Sanity access. Disabling PR-4 disables PR-5 (plan §4).
   - `auth()` in the handler: 401 when signed out.
   - Rollback deviation, stated plainly: plan PR-5's rollback keeps "explicit user-selected help" when adaptive selection is off. With the flag off, this route simply returns 404. No client-chosen level exists anywhere, so there is nothing to fall back to without re-adding one.

## Expected files

- **New:**
  - `lib/ai/help-policy.ts` and its `.test.ts`
  - `lib/assessments/hints.ts` and its `.test.ts` (strict schema and GROQ evaluation)
  - `lib/learner/help.ts` (`requestHelp` service)
  - `lib/learner/help.db.test.ts`
  - `app/api/help/route.ts`
- **Modified:**
  - `sanity/queries/assessments.ts` (`HINT_LADDER_QUERY`)
  - `lib/learner/content-source.ts` and `content.ts` (`loadHintLadder`)
  - `lib/learner/help-events.ts` (transaction-scoped record, instance level read)
  - `lib/learner/contracts.ts` (help request and response schemas, plus `hint_unavailable`)
  - `lib/learner/http.ts` (the status for `hint_unavailable`)
  - `lib/flags.ts`
  - `sanity.types.ts` (TypeGen)
- **No** migration, schema, Studio, `.env.example` or package change.

## Security considerations

- The hint ladder and answer key are read only server-side. The strict response schema allows exactly one hint string, and a test asserts that other rungs' text never appears.
- The learner id comes only from `auth()`. Every query runs through `asLearner` under RLS.
- No client-supplied level or history. `mode` and `request` can only increase the recorded assistance.
- No hint text is sent to PostHog, logs or the outbox.
- A retry with the same `requestKey` is idempotent. It returns the original rung even if the ladder changed afterwards, because the text is re-read for the stored level.

## Acceptance (the plan's list, each mapped to a named test)

- **Pure, table-driven** (`help-policy.test.ts`):
  - rule precedence (reference over solution over ambiguous over first help over escalation);
  - explicit override flags;
  - reference mode at any level;
  - ambiguous → 0;
  - the escalation ladder 0→1→2→3→3;
  - a repeated `hint` doesn't escalate;
  - the first help on a fresh instance → 1 (a task change).
- **Contracts:** a forged `level`, `helpLevel` or `userId` is rejected; the response has one hint and no answer-key fields.
- **Database** (`help.db.test.ts`, `TEST_DATABASE_URL`, under `vertex_learner_app`):
  - another learner's instance → 404 with nothing recorded;
  - retries (a same key replays with no escalation, even after a newer escalation);
  - concurrent different-key escalations serialize to distinct levels;
  - a task change (a new instance restarts at 1 while the family taint persists into grading);
  - unavailable hint material (stale, withdrawn, mismatched version, empty rung) → `hint_unavailable` with no `help_event` and no outbox row;
  - level 3, then submit → `assisted / answer_exposed`;
  - help after submission is allowed and leaves the grade unchanged;
  - an outbox row is written with no hint text;
  - with either flag off, the handler is never reached (route check).

## Checks

- `npm run typecheck`, `npm run lint`, `npm test` (Node 22) and `npm run build`.
- The database suite runs against a local `postgres:17` container:
  - `docker run -d --name vertex-pg -e POSTGRES_PASSWORD=postgres -p 54329:5432 postgres:17`
  - `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:54329/postgres npm test`
- A signed-out `POST /api/help` → 401.
- Nothing runs against Supabase or production, and there is no deploy.

## Manual tests (after the Supabase and content prerequisites in #10)

Signed in with both flags on:
1. Issue an instance, then request `hint` → level 1 direction text.
2. `escalate` twice → 2, then 3 (the solution).
3. Replay the first request's key → level 1 again, with `replayed: true`.
4. Submit → `evidence.kind = assisted`, `reasonCode = answer_exposed`.
5. `reference` mode on a fresh instance → level 3 immediately.

## Rollback

Turn off `help-policy`: `/api/help` returns 404. Recorded help events stay and keep informing grading. There is no migration to reverse.

## Not in this PR

- Free-text tutor questions, clarifying questions and any model call: PR-6.
- The UI: PR-7.
- An outbox dispatcher (see #10).
- Supabase verification (outstanding from #10).

## Implementation notes (2026-09-13)

These differ from, or go beyond, the plan above:

- **Shared delivery check.** `matchesDelivery` moved from `attempts.ts` to `task-instances.ts` (as `DeliveredItem`), so grading and help check the same thing: id, family, version and option ids. The grading lock is shared too, as `lockLearnerFamily` in `help-events.ts`.
- **Complete ladders only.** `hintLadderSchema` requires all three rungs. An empty rung makes the whole item `hint_unavailable` before any transaction, rather than only the level that is missing.
- **Key reuse across instances.** `help_event` has no request hash, so a `requestKey` that was first used on a different task instance returns 409 `idempotency_key_reused`. It never returns the other task's hint.
- **Shared test fixture.** `FixtureContent` moved to `lib/learner/test-content.ts`, and `attempts.db.test.ts` now imports it.
- **Route gating test.** `lib/learner/help-route.db.test.ts` loads the unchanged route through module hooks. Only Clerk `auth()`, the PostHog client, `getDb` and the Sanity source are stubbed. It shows that a signed-in learner with either flag off gets 404, with no content read and no database access.
- **Mastery after exposure.** `help.db.test.ts` asserts that a correct answer after a revealed solution leaves `independent_correct = 0` and the status `assisted_only`. This holds for reference mode, for study-mode escalation, and for a new instance of the same family.
- **Local database.** The test database was an embedded Postgres 17.10, because the local Docker image store was broken. The suites are unchanged: `TEST_DATABASE_URL=… npm test`.
- **Fresh worktree.** `npm run typecheck` needs Next's generated route types (`LayoutProps`). Run `npx next typegen`, `next dev` or `next build` once first.
