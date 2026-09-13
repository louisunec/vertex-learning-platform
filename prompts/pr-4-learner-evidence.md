# PR-4: Private learner evidence and server-side grading

## Goal

Implement the fourth increment of `docs/Vertex_AI_Native_Development_Plan.md` (§5 PR-4): persist trustworthy learning evidence in Supabase Postgres, separate from video completion, with server-side grading of reviewed single-choice assessments.

- `POST /api/task-instances` issues a server-owned task instance for one published, approved, current assessment and returns the learner-safe item.
- `POST /api/attempts` grades a submission against that exact instance, records the attempt, updates the concept evidence projection and writes an outbox event in **one transaction**, idempotently.
- Help events are persisted separately through a service (the help *policy* and its route are PR-5).
- There is no UI. Lesson integration is PR-7.
- Everything is behind a new PostHog flag, `learner-evidence`, which is off by default and fails closed.

## Guidance read

- `AGENTS.md` §2, §3 (high-risk: auth, schema/migrations, public contract), §6, §7, §11, §12. `CLAUDE.md` approval rules.
- Development plan §3 (data ownership, request authorization, versioning and consistency), §4, §5 PR-1/PR-3/PR-4/PR-5/PR-7/PR-8, §6.
- `prompts/pr-3-concepts.md`, which sets the format and conventions.
- Memory:
  - Supabase is the Postgres provider.
  - Flags are PostHog, evaluated server-side and failing closed.
  - Sign-in is required for practice and attempts.
  - The agent shell needs Node 22 via nvm.
  - The read token is Editor-grade.
- To read during implementation: `node_modules/next/dist/docs/01-app` route-handler guide (request body, `NextResponse`, dynamic behaviour) and the installed `postgres` package README (transactions, `prepare: false` for the Supabase pooler).

## Code inspected (on `feat/pr-3-concepts` @ `9933a18`)

- `lib/flags.ts`: the `FLAGS` map and `isFlagEnabled` (fail-closed).
- `proxy.ts`: `clerkMiddleware()` with no route protection. Authorization therefore stays inside each handler.
- `app/api/search/route.ts`: the pattern for `auth()` inside a handler, and the explicit error statuses.
- `lib/assessments/learner.ts` and `sanity/queries/assessments.ts`: the strict learner projection and `LESSON_PRACTICE_ITEMS_QUERY` (the answer key is never selected).
- `studio/schemaTypes/documents/assessment.ts`:
  - `familyId`, `version`, `options[]._key` (stable option ids), `answerKey.correctOptionId`, `hints`;
  - `primaryConcept`, which stays editable after approval, so `_rev` can change without any content change;
  - `reviewStatus` and `sourceStatus`.
- `studio/schemaTypes/documents/concept.ts` and `lib/concepts/resolve.ts`: the stable `conceptId`, merge tombstones, and `resolveConcept` → `active | split | unavailable`.
- `sanity/lib/{client,fetch}.ts`: the published-perspective server client and `revalidate: 0` for per-request reads.
- `sanity/data/progress.ts` and `lib/course-progress.ts`: watch progress lives in Sanity `progress` docs and is **untouched** by this PR.
- `package.json`, `.env.example`, `.env.local` (key names only): no DB driver, no DB env vars, no migrations directory.
- Environment: Docker is available; `psql`, `postgres` and the Supabase CLI are not installed.
- **Live dataset: 0 `assessment` and 0 `concept` documents in any state, drafts included.** Fixtures cover every automated test. A manual end-to-end run needs content (see *Needs your attention*).

## Decisions and assumptions

1. **Access model (preflight finding).**
   - There are no organizations and no paid entitlements; course content is public.
   - Entitlement for practice means:
     - the learner is signed in;
     - the assessment is published (not a `drafts.`/`versions.` id);
     - `reviewStatus == "approved"` and `sourceStatus == "current"`;
     - its lesson reference resolves to a published lesson.
   - Scope columns hold only `learner_id` (the Clerk user id from `auth()`). No multi-tenancy is invented.
2. **DB access: the `postgres` driver (porsager) over `DATABASE_URL`, not `supabase-js`.**
   - The plan requires attempt + projection + outbox in one transaction. `supabase-js` (PostgREST) has no client transactions, so it would push the evidence policy into PL/pgSQL.
   - With `postgres`, `sql.begin()` keeps the policy in a tested TypeScript module. Integration tests run against a plain Docker Postgres.
   - The client is server-only (`import 'server-only'`), with a small pool (max 5), `prepare: false` (Supabase transaction pooler), a connect timeout and a statement timeout.
3. **Tables live in a dedicated `learner` schema.**
   - Supabase's Data API exposes only `public` by default.
   - As defence in depth: `ENABLE ROW LEVEL SECURITY` with no policies, and `REVOKE ALL … FROM anon, authenticated` (guarded so the migration also runs on a plain Postgres, where those roles don't exist).
   - The server connects as the DB owner, so application code remains the authorization boundary.
4. **One migration strategy.**
   - Plain SQL files in `db/migrations/NNNN_name.sql`.
   - They are applied in order by `npm run db:migrate`: a small script using the same driver and a `learner.schema_migrations` table, one transaction per file, forward-only.
   - The same runner migrates the test database.
5. **Tables (additive, `timestamptz` UTC, `bigint`/`uuid` ids).**
   - `task_instance`:
     - `id uuid`, `learner_id`, `assessment_id` (published `_id`), `family_id`, `assessment_version`, `lesson_id`;
     - `delivered_option_ids text[]` (in delivered order);
     - `issued_at`, `expires_at` (issued_at + 24 h).
   - `attempt_log`:
     - `id`, `learner_id`, `task_instance_id` (unique: one graded submission per instance), `assessment_id`, `family_id`, `assessment_version`;
     - `selected_option_id`, `correct bool` (the server grade);
     - `hint_level_used smallint`, `answer_exposed bool`;
     - `self_confidence smallint null`, `confidence_signal text null` (`pre_feedback_1to5_v1`);
     - `evidence_kind` (`independent | assisted | not_counted`), `evidence_reason`;
     - `primary_concept_ref`, `resolved_concept_id`, `concept_resolution` (`active | split | unavailable | none`);
     - `policy_version`, `idempotency_key`, `request_hash`, `created_at`;
     - `unique (learner_id, idempotency_key)`.
   - `help_event`:
     - `id`, `learner_id`, `task_instance_id null`, `session_id null`, `family_id null`, `concept_ids text[]`;
     - `level smallint 0–3`, `explicit_override bool`, `policy_version`, `reason_code`;
     - `request_key` (unique per learner, so a retried help request never escalates), `created_at`.
   - `concept_mastery`:
     - primary key `(learner_id, concept_id)` (the stable `cpt-…` id);
     - `independent_correct`, `independent_incorrect`, `assisted_correct`, `assisted_incorrect`;
     - `estimate numeric null`, `evidence_status` (`unknown | assisted_only | independent`), `policy_version`, `updated_at`.
   - `explanation_log`: created **by the migration only**, because the plan lists it as a PR-4 table. There are no writers until PR-8.
   - `event_outbox`: `id uuid`, `event_type`, `payload jsonb` (ids and enums only), `status` (`pending`), `attempts`, `next_attempt_at`, `created_at`. **Rows are written, but there is no dispatcher.** Delivery arrives with the first consumer (PR-5's `help_level_decided` or PR-10).
6. **Task-instance issuance (`POST /api/task-instances {assessmentId}`).**
   - A new server-only GROQ query loads one assessment by id under the servable filter (the same predicates as `LESSON_PRACTICE_ITEMS_QUERY`, including "latest servable version of its family").
   - The server inserts the instance and returns `{taskInstanceId, expiresAt, item}`. `item` is parsed through the existing strict `learnerAssessmentSchema`, so no answer key or hints can leak.
   - A non-servable or unknown id returns 404.
7. **Grading (`POST /api/attempts {taskInstanceId, optionId, selfConfidence?, idempotencyKey}`).**
   - A separate server-only query, `ASSESSMENT_FOR_GRADING_QUERY`, selects `answerKey.correctOptionId`, `familyId`, `version`, `options[]._key`, `primaryConcept._ref` and the servable predicates.
   - It is parsed by a strict Zod schema that is **never** part of any response type.
   - The instance must belong to the caller. Another learner's instance returns the same 404 as a missing one.
   - An expired instance returns 410. `optionId` must be in `delivered_option_ids` (400).
   - The item must still be servable and match the delivered version and option-id set. Otherwise the server returns 409 `task_unavailable` and records nothing, so a known-stale item is never graded.
   - The response is `{attemptId, taskInstanceId, correct, evidence: {kind, reasonCode}}`. It **does not reveal the correct option or the explanation.** Exposing the answer is a level-3 help action (PR-5), and it has to be recorded as exposure.
8. **Idempotency and concurrency.**
   - `request_hash` = sha256 of the canonical `{taskInstanceId, optionId, selfConfidence}`.
   - Same key and same hash → the stored result, with `Idempotent-Replayed: true`, and no evidence change.
   - Same key and a different hash → 409 `idempotency_key_reused`.
   - A different key on an already-submitted instance → 409 `already_submitted`.
   - Concurrent duplicates serialize on the unique indexes.
   - Inside the transaction, `pg_advisory_xact_lock(hashtext(learner_id || ':' || family_id))` is taken **before** the "first response to this family?" check. Two concurrent instances of one family therefore can't both count as independent.
9. **Evidence policy (`lib/learner/evidence.ts`, pure, versioned `evidence-v1`).**
   - Classification, in precedence order:
     1. A prior attempt by this learner on the same `familyId` (any version) → `not_counted` / `repeat_task`.
     2. Any level-3 help event for this family → `assisted` / `answer_exposed`.
     3. Help level > 0 on this instance → `assisted` / `hint_used`.
     4. Otherwise → `independent` / `first_independent_response`.
   - `hint_level_used` and `answer_exposed` come **only** from `help_event` rows. The request schema has no help, score or correctness field; strict parsing rejects extra keys.
   - Estimate: Beta(1,1) mean `(1 + ic) / (2 + ic + ii)`, computed only when `ic + ii > 0`. Otherwise `estimate = null` and the status is `unknown` (or `assisted_only`).
   - It is documented in code as an uncalibrated heuristic. There is no mastery gate.
10. **Concept handling.**
    - A single primary concept per item.
    - `primaryConcept._ref` is resolved through `resolveConcept` against a bounded published concept-node query.
    - `active` → upsert `concept_mastery` for the resolved `conceptId` (merges follow to the successor).
    - `split` → attempt stored with `concept_resolution = 'split'` and no projection update. This is the conservative reconciliation the PR-3 resolver asks for.
    - `unavailable` / no concept → attempt stored, projection skipped.
11. **Help-event service (`lib/learner/help-events.ts`).**
    - `recordHelpEvent({sql, learnerId, …})`: an idempotent insert by `request_key`.
    - `getHelpState({sql, learnerId, taskInstanceId, familyId})`: the max level on the instance, plus any family exposure.
    - It has no route; PR-5 adds `decideHelpLevel` and the endpoint.
12. **Flag, auth and bounds.**
    - `FLAGS.learnerEvidence = 'learner-evidence'`. When it is off, both routes return 404 before any DB or Sanity access.
    - `auth()` runs inside each handler (401 when signed out), then the flag is evaluated for that user id.
    - Bodies are limited to 2 KB, parsed with strict Zod.
    - `idempotencyKey` must match `^[A-Za-z0-9_-]{16,64}$`. `selfConfidence` is an integer from 1 to 5.
    - Responses carry `Cache-Control: no-store`.
    - A DB or Sanity outage returns 503 (retryable), never a grade.
13. **Unchanged.**
    - The Sanity schema, Studio, MCP context scope, search and watch progress are untouched.
    - Nothing is sent to PostHog from this PR except flag evaluation.
14. **Branch.**
    - Create `feat/pr-4-learner-evidence` from `9933a18`.
    - The uncommitted dark-theme edits and `prompts/jsmastery-dark-theme.md` stay unstaged and out of PR-4 commits.

## Expected files

- New:
  - `db/migrations/0001_learner_evidence.sql`
  - `scripts/db-migrate.mts`
  - `lib/db/client.ts`, `lib/db/migrate.ts`
  - `lib/learner/{contracts,evidence,task-instances,attempts,help-events}.ts`
  - `lib/learner/{contracts,evidence}.test.ts`: pure, always run.
  - `lib/learner/{attempts,help-events,migrate}.db.test.ts`: skipped unless `TEST_DATABASE_URL` is set.
  - `app/api/task-instances/route.ts`, `app/api/attempts/route.ts`
- Modified:
  - `sanity/queries/assessments.ts`: the single-item learner query, the grading query and the concept-node query.
  - `lib/assessments/grading.ts` (new, strict grading-row schema) and its test.
  - `lib/flags.ts`
  - `.env.example`: `DATABASE_URL`, `TEST_DATABASE_URL`, both server-only.
  - `package.json`: the `postgres` dependency and the `db:migrate` script.

## Security considerations

- The answer key and hints are read only by the grading query. The grading schema is internal, and route responses are built from explicit response schemas. A test asserts that no response shape contains `answerKey`, `correctOptionId`, `hints` or `solution`.
- The learner id comes only from `auth()`. The client can't supply `userId`, a score, correctness, a help level or exposure.
- All SQL is parameterized through tagged templates; no string-built SQL.
- `DATABASE_URL` is server-only. No `NEXT_PUBLIC_` variable is added.
- Evidence rows hold ids and enums only. There is no free text in PR-4.

## Acceptance criteria

- Another learner's task instance → 404; unavailable, stale or archived content → 404 on issue and 409 on submit.
- Forged fields (`userId`, `correct`, `score`, `hintLevel`) → 400 (strict schema).
- A changed body under the same key → 409.
- Concurrent duplicate submissions → exactly one attempt row and one projection increment.
- Rollback: a failure injected after the attempt insert leaves no attempt, projection change or outbox row.
- Stable option ids, independent of delivered order.
- The projection updates for independent and assisted outcomes; a split concept leaves the projection untouched.
- Repeated answers after answer exposure, or repeat instances of the same family, never raise `independent_correct`.
- The flag off → 404; signed out → 401.
- Watch progress code paths are unchanged.

## Checks

- `npm run typecheck`, `npm run lint`, `npm test` (Node 22 via nvm), `npm run build`.
- The DB suite runs against local Docker Postgres:
  - `docker run -d --name vertex-pg -e POSTGRES_PASSWORD=postgres -p 54329:5432 postgres:17`
  - `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:54329/postgres npm test`
- If Docker can't run, those tests are reported as **not run**.

## Manual tests (after Supabase and content exist)

1. Set `DATABASE_URL` (the Supabase pooler URI) in `.env.local`, then run `npm run db:migrate`. A second run applies nothing.
2. In Supabase: the `learner` schema is not exposed, and RLS is enabled on every table.
3. With the flag off: `POST /api/attempts` → 404. With the flag on and signed out → 401.
4. Signed in, with the flag on for your user: issue an instance for an approved assessment that has a `primaryConcept`, then submit.
   - Expect `correct` and `evidence.kind = independent`.
   - A `learner.concept_mastery` row is created.
5. Replay the same request → an identical body plus `Idempotent-Replayed: true`, and the row counts don't change.
6. Issue a second instance of the same assessment and answer it → `not_counted / repeat_task`, with mastery unchanged.

## Rollback

- Turn off `learner-evidence`: both routes return 404, and nothing else reads the tables.
- The tables are additive and stay intact. There is no down-migration and no data deletion.

## Amendment (2026-09-13, approved by the user): the app role runs under RLS

This replaces Decision 3's "the server connects as the DB owner, so application code remains the authorization boundary". The user asked for RLS tests under the application's own role and identity, and the owner connection bypasses RLS, so the design changed:

- **The role.** Migration 0001 creates `vertex_learner_app`, a `NOLOGIN` role. The migration aborts if the role is a superuser or has `BYPASSRLS`.
  - The connecting role is granted membership with `SET` (explicitly on Postgres 16+).
  - `DATABASE_URL` is unchanged.
- **Least-privilege grants.**
  - `SELECT, INSERT` on `task_instance`, `attempt_log` and `help_event`.
  - `SELECT, INSERT` on `concept_mastery`, plus `UPDATE` on its counter, estimate, status, policy and timestamp columns only.
  - `INSERT` only on `event_outbox`.
  - Nothing on `explanation_log` (PR-8) or `schema_migrations`.
  - No `DELETE` or `TRUNCATE` anywhere.
- **Policies.** Each learner table is limited to `learner_id = current_setting('app.learner_id', true)` for both reads and writes. An outbox insert must carry `payload.learnerId` equal to the same setting. An unset or empty identity matches nothing.
- **Services.** `lib/db/learner-scope.ts` `asLearner(db, learnerId, fn)` runs one transaction that does `SET LOCAL ROLE vertex_learner_app` and sets `app.learner_id` (plus a 5 s statement timeout), both transaction-local.
  - Every query in the task-instance, help-event and attempt services runs inside it.
  - The attempt service uses two scoped transactions, with the Sanity read in between.
  - The explicit `learner_id` filters and 404-for-foreign-instance checks remain.
- **Tests.**
  - `lib/learner/rls.db.test.ts` runs as `vertex_learner_app` with a learner id. It checks:
    - other learners' rows are invisible;
    - forged writes, cross-learner updates, re-owning a row and deletes are denied;
    - the outbox is write-own-only;
    - with no identity (unset or empty), nothing is visible or writable;
    - nothing carries over on a reused connection.
  - It also runs as Supabase's `anon`/`authenticated` roles with a learner's JWT claims, both without grants and after a deliberately mistaken grant, where the policies still deny everything.
  - The whole attempts suite runs under the role.
  - A negative control, with RLS disabled on one table, exposed the other learner's rows, confirming the tests detect a missing policy.
- **Outstanding: Supabase verification.** Nothing here has run against Supabase. On a Supabase project (non-superuser `postgres`), check:
  1. `npm run db:migrate` can create `vertex_learner_app` and grant membership;
  2. `SET LOCAL ROLE` works through the transaction pooler;
  3. the `learner` schema stays unexposed with RLS on.
