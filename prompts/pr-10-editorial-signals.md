# PR-10: Editorial learning signals and content feedback

## Goal

Give instructors investigation prompts, not verdicts, for:

- assessments that may need correction (high first-attempt error rate);
- lesson moments learners repeatedly replay;
- searches and tutor questions for which the system found insufficient evidence.

The PR also completes PR-4's outbox delivery to PostHog and keeps the plan's link back to the content pipeline: signals can queue bounded draft regeneration candidates, behind a switch that is off by default.

## Approval

The user asked to "proceed through implementation and verification" and to "resolve routine decisions independently" (2026-09-14). This is the explicit bypass that AGENTS.md §3 and CLAUDE.md allow. This file is the decision record; it is not a substitute approval.

## Guidance read

- `AGENTS.md` §2 (invariants), §3, §9 (search), §10–§13; `CLAUDE.md`.
- `docs/Vertex_AI_Native_Development_Plan.md` §2, §3, §4 and §5 PR-10 (plus PR-1, PR-4, PR-6, PR-7 for contracts).
- Memory: the PR stack and the migration sequence, the `vertex-search` Context scope, the `phs_` PostHog key being read-only, and the toolchain notes (Node 22, embedded Postgres).
- Installed `posthog-node@5.51.4` source: `captureImmediate` → `sendImmediate` catches send errors and only emits `'error'`, so it cannot confirm delivery.

## Base and dependencies

- **Branch:** `feat/pr-10-editorial-signals`, in the worktree `../vertex-pr-10`.
- **Base:** `3de183e` (PR-7, local). The plan lists PR-1, PR-4, PR-6 and PR-7 as prerequisites. `3de183e` is the smallest commit that contains all four (PR-7 → #14 `a807055` → PR-6 #12 → PR-5 → PR-4 → PR-3 → PR-1). Nothing here needs focused review, PR-9, PR-11 or PR-12.
- **Migration number:** `0007`. `0003`–`0005` are on other branches and `0006` belongs to PR-12 (draft PR #17). The runner applies files by name, so `0007` works with or without them. It depends only on `0001` and `0002`.

## Code inspected

- `db/migrations/0001_learner_evidence.sql`: `learner.event_outbox` (id, event_type, payload, status pending/delivered/failed, attempts, next_attempt_at, last_error). The learner role can only insert into it, and the payload carries `learnerId`, which RLS checks.
- Outbox writers:
  - `lib/learner/attempts.ts` writes `attempt_graded`;
  - `lib/learner/help.ts` and `lib/tutor/service.ts` write `help_level_decided`;
  - `lib/tutor/service.ts` writes `tutor_answered`.
  - All three commit in the same transaction as the learner write. There is no dispatcher.
- `db/migrations/0002_tutor_requests.sql` and `lib/tutor/service.ts`:
  - `tutor_request` records `insufficient_evidence` only after retrieval ran across window → lesson → course.
  - A model or Sanity outage throws before the record (503) and never creates a row.
  - The playhead is not stored.
- `lib/learner/evidence.ts`: `independent` means the first response to the family with no hint. `assisted` means a hint was used or the answer shown. `not_counted`/`repeat_task` means a retry.
- `components/lesson/video-embed.tsx` and `lesson-player.tsx`:
  - Existing events: `video_played` (once), `video_watch_depth` (25/50/75/90), `lesson_completed`.
  - No seek or replay events.
  - Citation seeks go through `LessonPlayer.seekTo`.
- `components/search/search-results.tsx`: the client `search_performed` event has `status: success|error`.
  - The raw query is attached (pre-existing behaviour).
  - HTTP 502 (MCP unavailable) and 500 are both `error`.
  - `lib/search/interpret.ts` silently falls back to deterministic terms on an LLM error or timeout, so "0 results" can hide a degraded interpretation.
- `lib/posthog-server.ts`, `lib/flags.ts`, `instrumentation-client.ts` (posthog-js with cookie persistence), and `posthog-node`'s exported `readPostHogCookie`.
- Studio:
  - `studio/structure.ts` (review queues);
  - `studio/sanity.config.ts` (`GENERATOR_ONLY_TYPES`, action filtering);
  - `studio/actions/*`;
  - `assessment-generation-record.ts`.
- `scripts/generate-assessments.mts`, `lib/assessments/pipeline.ts` and `generate.ts`:
  - `planGeneration` never writes a published version; it adds `v+1` instead.
  - An unpublished draft is replaced in place.
  - `--force` deletes unreproduced unpublished drafts.
  - Family ids encode the unit (`asm-<hash>-s<span>-q<n>`, `asm-<hash>-t-q0`).
- `scripts/sanity-http.mts` (offline Sanity HTTP helper), `lib/db/learner-scope.ts`, `lib/db/test-db.ts`, `lib/db/migrate.db.test.ts`.
- `.env.example`, `package.json`. There is no job platform: jobs are npm scripts only, with no `vercel.json` crons and no GitHub workflows.
- Credentials available locally:
  - `POSTHOG_SECRET_KEY` is `phs_` (flag evaluation only).
  - There is no personal API key (`phx_`) and no project id, so the HogQL query API is unavailable.
  - There is no `SANITY_API_WRITE_TOKEN`.

## Decisions

### 1. Outbox delivery (`lib/outbox/`, `npm run outbox -- …`)

- **Migration `0007`:**
  - adds lease columns to `learner.event_outbox`: `claimed_by`, `claimed_until`, `delivered_at`;
  - widens `status` with `suppressed`, for events from labelled synthetic learners, which are never sent.
  - `failed` is the dead-letter state.
- **Claiming:** `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED LIMIT n)`.
  - It takes due `pending` rows whose lease is empty or expired.
  - It sets the lease and increments `attempts` at claim time, so a crash still counts the attempt and a poison row cannot loop forever.
- **Abandoned claims:** a claim whose lease expired is claimable again. Expired claims already at the attempt cap are swept to `failed`.
- **Sink:**
  - a raw `fetch` POST to PostHog's public `/batch/` capture endpoint with the project token, bounded by a timeout;
  - HTTP 2xx means accepted.
  - `captureImmediate` is not used because it swallows errors (see above).
- **Stable ids:** the PostHog event `uuid` is the outbox row id, and the event `timestamp` is the row's `created_at`. A resend is byte-identical, so it carries the same `uuid`, `event`, `timestamp` and `distinct_id`, the fields PostHog merges duplicates on.
- **Retry and backoff:** after a failure, `next_attempt_at = now() + min(30 s · 2^(attempts−1), 6 h)` and `last_error` holds a category (never a payload). At 8 attempts the row becomes `failed`. `npm run outbox -- requeue` moves failed rows back with `attempts = 0`.
- **Accepted by PostHog, then the local update fails:** the row keeps its lease. After the lease expires another run resends it with the same `uuid` and `timestamp`.
  - The guarantee is at-least-once delivery with a stable event id.
  - PostHog merges such duplicates only eventually, on ClickHouse merges, and does not guarantee it (PostHog events docs). The signal readers therefore keep one event per `uuid`, and analyses that need exact counts should count distinct `uuid`.
  - Exactly-once is not claimed.
- **Marking delivered:** by id, while the row is still `pending`, regardless of the current claimant. Once PostHog has accepted an event, recording that is always correct. A failure is recorded only by the claimant (`claimed_by = me`), so a stale worker never double-counts attempts.
- **Approved fields only:**
  - Each event type has an explicit allowlist and a Zod-validated projection (`lib/outbox/projection.ts`), with snake_case names as in the existing PostHog events.
  - `learnerId` becomes the PostHog `distinct_id` only. It is the Clerk id that `posthog-identity.tsx` already identifies with, so no new identifier is introduced. It never appears in the properties.
  - Internal row ids are dropped: `attemptId`, `helpEventId`, `tutorRequestId`, `taskInstanceId`, `sessionId`.
  - A payload that fails its projection is dead-lettered as `invalid_payload`: visible in `status`, requeueable, never sent.
  - An event type with no projection is **held**. It is never claimed, sent, dead-lettered or marked delivered, and it keeps its attempt budget. `status` lists it until a projection is added.
  - PR-12's `submission_reviewed` has a projection. It drops the submission, review and help-event ids; its payload holds no code or finding text.
- **Credential:**
  - A new NOLOGIN role, `vertex_signals_worker`, with no bypass of RLS, is reached via `SET LOCAL ROLE` as `asLearner` does (`lib/db/worker-scope.ts`).
  - It can select the outbox and update only the delivery columns. RLS policies grant it only these rows.
  - A dedicated LOGIN user for production is documented as a Supabase step.
- **Grading independence:** attempts and help keep committing their outbox rows as today. The dispatcher never touches learner tables.

### 2. Signal aggregation (`lib/signals/`, `npm run signals -- aggregate`)

**Windows**
- Fixed UTC windows, aligned to Mondays, 7 days by default (`--window-days` 1–28). The default run processes the last completed window plus one earlier window for late events. `--include-current` also processes the in-progress window, marked `partial`.
- Windows are half-open: `[start, end)`.

**Keys and idempotency**
- The document id is `contentSignal-<type>-<sha256(subject)[:16]>-<yyyymmdd>-<days>d`.
- Rerunning a window recomputes from source rows and sets the metrics; nothing is incremented, so the same source events are never counted twice.
- A signal that no longer meets its threshold on a rerun is kept, with `thresholdMet: false`.

**Synthetic activity**
- A new table, `learner.synthetic_learner` (Clerk id, label `synthetic|test|demo|staff`), managed with `npm run signals -- synthetic add|list`.
- These learners are excluded from every aggregate and from outbox delivery.
- There was no label before this PR. The demo tooling marks its accounts only in Clerk metadata, so the integration session must register them.

**Assessment difficulty** (Postgres `attempt_log`, as the worker role)
- Grouped by `assessment_id` (the immutable version document) and `assessment_version`, so versions never mix.
- Counts:
  - eligible = independent first responses;
  - their errors;
  - distinct learners among them;
  - assisted attempts and their errors;
  - retries (`repeat_task`);
  - all distinct learners.
- The rule is raised when eligible ≥ 20 and the independent error rate > 60 %. Both values are configurable, and the rule version is stored.
- **Denominator:** the learner's first independent response to the assessment family, delivered as this version. One per learner, so it equals the distinct eligible learners; both counts are shown.
- The plan's "20 distinct learners" and the user's "20 eligible attempts" therefore coincide.
- A learner who first answered v1 counts only for v1: their v2 response is a retry.

**Tutor insufficient evidence** (Postgres `tutor_request`)
- Counts `status = 'insufficient_evidence'` per lesson and window, with distinct learners, the scope searched, and the lesson's total tutor requests as the denominator. Raised at 3 or more distinct learners.
- `0007` adds a nullable `tutor_request.current_seconds`, written by the tutor, so the panel can show the most common 60-second playhead bucket. Older rows show "not recorded".
- Provider, timeout and Sanity failures never create rows (PR-6), so they cannot become signals.
- If the tutor is off, this source is simply empty; the other types still run. Every type runs and fails independently.
- The wording is "found insufficient supporting material in the course sources searched", never "not covered".

**Search with no grounded results** (PostHog `search_outcome`, new, server-side)
- `/api/search` captures `search_outcome` in `after()` for first pages only, gated by the `editorial-signals` flag, with:
  - `outcome`: `results | no_results | no_results_degraded | no_terms | unavailable | failed`;
  - `interpretation`: `model | deterministic | fallback_after_error`;
  - `result_count`;
  - `terms_fingerprint`, and `terms` (≤ 6 tokenized deterministic terms, never the raw query).
- The distinct id is the Clerk id, else the posthog-js anonymous id from its cookie, else `anonymous`.
- Only `no_results` with a successful interpretation counts as a content gap. The other outcomes are reported as excluded infrastructure or no-term counts in the job summary.
- Grouped by fingerprint; raised at 3 or more distinct people. The terms appear in a collapsed "tokenized terms" field, only on raised signals (so at least 3 people share them).
- By the user's decision (follow-up below), the browser's `search_performed` and `search_result_clicked` no longer carry the raw `query`.

**Repeated replay** (PostHog `video_seeked`, new, client-side)
- Detection:
  - The lesson player compares the playhead with its prediction on the existing 1 s poll and on resume from pause.
  - A jump of more than 2.5 s is a seek. Rapid scrubbing is merged into one seek.
  - The start position (`?t=`, resume) is never a seek.
- Classification:
  - backward within 180 s = `replay`;
  - forward = `skip`;
  - backward more than 180 s = `rewind_far`;
  - a seek within 3 s of a `LessonPlayer.seekTo` target in the last 5 s = `citation` origin.
- At most 50 seek events per page view. Behind the `editorial-signals` flag, read from posthog-js in the browser once per view at the first play. The lesson page's server render never evaluates it (follow-up below).
- **Aggregation:** learner-origin replays per lesson, video, and 30-second target bucket; distinct people, with repeats by one person counted once.
- **Denominator:** distinct people with `video_played` for that lesson in the window **with seek tracking on**. `video_played` now carries `lesson_id`, `video_id` and `seek_tracking`, so views that could never report a replay do not dilute the share. Older events lack these fields and are ignored.
- Raised at 5 or more distinct replayers and at least 20 % of viewers. Labelled "potential friction or interest".

**PostHog reader**
- An `EventReader` interface with two implementations:
  - HogQL (`POST {POSTHOG_API_HOST}/api/projects/{POSTHOG_PROJECT_ID}/query/`, personal key with `query:read`), selecting only the needed non-text properties, parameterized by `values`, and paginated to at most 20 000 rows per event type and window;
  - a JSON fixture file.
- The HogQL path is unverifiable here: no `phx_` key and no project id exist.

### 3. Studio signal panel

- A `contentSignal` document, `liveEdit` (no drafts). Computed fields are read-only:
  - type and neutral title;
  - lesson and assessment weak references, with family and version;
  - timestamp or range;
  - window;
  - numerator, denominator and its label, rate, distinct learners, and the supporting measurements;
  - the rule text and its version;
  - `thresholdMet`, `partial`, `fixture`, `computedAt`;
  - the regeneration status.
- Review fields are editable:
  - `reviewStatus`: `open | investigating | acknowledged | resolved`;
  - `reviewNote`;
  - `reviewedAt` / `reviewedBy`, set by document actions ("Start investigating", "Acknowledge", "Resolve", "Reopen").
- Structure: "Content signals" with lists by status and by type, plus "No longer meets threshold".
- Signals are created only by the job, so the type is in `GENERATOR_ONLY_TYPES`. Delete and duplicate are removed.
- The writer uses `createIfNotExists` and then `patch.set` on computed fields only, so a rerun never resets the review.
- No learner text is stored. The only learner-derived strings are search terms shared by at least 3 people, in a collapsed field.
- Titles are neutral, e.g. "High first-attempt error rate", "Repeated replays around 3:30", "Tutor found insufficient supporting material", "Searches with no grounded results".
- **Out of learner search and public APIs:**
  - the Context MCP filter allowlists only course, lesson, video, instructor and category (and `videoVisualIndex` in the repo ndjson), which is verified;
  - no web GROQ query selects `contentSignal`, and a guard test covers this.

### 4. Content regeneration

- Only `assessment_difficulty` signals whose threshold is met can queue a candidate, in a new table `editorial.regeneration_candidate` with `unique (source_key, queued_day)`.
- `source_key` is the assessment's generation `spanKey`, which covers the lesson, video, chunk revisions, prompt, model and config. That gives one candidate per source revision per UTC day.
- There is a daily queue cap (default 5).
- **Execution** (`npm run signals -- regenerate --execute`) needs `SIGNALS_REGENERATION_ENABLED=true`; otherwise it lists the queue.
  - It claims candidates with a lease and reuses `processLesson`, restricted to the flagged unit, with `force` for that unit and no stale-marking side effects.
  - It uses the existing generation records and the existing `SANITY_API_WRITE_TOKEN`.
  - Each run is capped at 2 candidates and 2 model calls.
- **Guards:**
  - it skips a unit that has any unpublished draft (`draft_pending_review`), so it never replaces or deletes an editor's draft;
  - every emitted assessment mutation must be a `createOrReplace` of a `drafts.` id at a new version number;
  - no deletes and no patches of published documents;
  - the only non-draft write is the unit's `assessmentGenerationRecord`, as in the generator.
- The drafts enter the existing "Needs review" queue with `needs_review`.
- Nothing is published or approved, and no attempt, grade or published version changes.

### 5. Execution and configuration

- `npm run outbox -- dispatch | status | requeue` and `npm run signals -- aggregate | status | synthetic | regenerate`.
- Offline Node scripts (`--env-file-if-exists=.env.local`), as existing tooling. No scheduler is added.
- `docs/EDITORIAL_SIGNALS.md` documents:
  - cron examples: outbox every 5 min, signals daily;
  - credentials and flags;
  - the delivery guarantee;
  - rollback.
- New env vars in `.env.example`:
  - `POSTHOG_PERSONAL_API_KEY`, `POSTHOG_PROJECT_ID`, `POSTHOG_API_HOST` (aggregation);
  - `SANITY_API_SIGNALS_WRITE_TOKEN` (the separate credential for signal documents);
  - `SIGNALS_REGENERATION_ENABLED`.
  - The dispatcher reuses `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN`/`HOST`: capture needs only the public token.
- Flag: `editorial-signals` (new instrumentation only), off by default and fail-closed. It is not created in PostHog: the key is read-only, and the user owns shared configuration.
  - The browser reads it for `video_seeked`.
  - The server reads it with local evaluation only, after the response, for `search_outcome`.

## Expected files

- `db/migrations/0007_editorial_signals.sql`
- `lib/db/worker-scope.ts`; `lib/db/migrate.db.test.ts` (new tables and grants)
- `lib/outbox/{projection,posthog-sink,dispatch,status}.ts` and tests
- `lib/signals/{config,windows,keys,assessment-difficulty,tutor-gaps,search-gaps,replay,posthog-reader,documents,run,regenerate,synthetic}.ts` and tests
- `lib/video/seek.ts` and its test; `components/lesson/video-embed.tsx`, `components/lesson/lesson-player.tsx`, `app/lessons/[slug]/page.tsx` (minimal)
- `lib/search/interpret.ts`, `lib/search/search.ts`, `lib/search/outcome.ts` and its test, `app/api/search/route.ts`
- `lib/tutor/service.ts` (`current_seconds`)
- `lib/assessments/pipeline.ts` (`unitFilter`, `markStale` options), `lib/assessments/sources.ts` (shared GROQ), `scripts/generate-assessments.mts` (import the shared queries)
- `lib/flags.ts`
- `scripts/outbox.mts`, `scripts/signals.mts`, `package.json`
- `studio/schemaTypes/documents/content-signal.ts`, `studio/schemaTypes/index.ts`, `studio/structure.ts`, `studio/sanity.config.ts`, `studio/actions/content-signal-review.ts`
- `sanity.types.ts` / `studio/schema.json` (typegen)
- `.env.example`, `docs/EDITORIAL_SIGNALS.md`, this file

## Security considerations

- No new browser credentials. The dispatcher uses the public project token server-side. The HogQL personal key and the signals write token are offline-only.
- No raw submissions, explanations, questions or search text reach PostHog from the outbox, or Sanity from the jobs. Only an allowlisted set of ids and enums is sent, and tests assert it.
- The worker role cannot bypass RLS. Its policies cover only the tables it needs, and it gets no DELETE.
- `contentSignal` is excluded from the Context MCP scope, and no learner route reads it.
- Regeneration can never publish, approve, delete, or modify a published document.

## Acceptance criteria and checks

- DB tests:
  - concurrent dispatchers claim disjoint rows;
  - an abandoned claim is recovered after its lease;
  - partial success resends with the same uuid;
  - backoff and dead-lettering work;
  - synthetic events are suppressed;
  - grading still commits while the sink is down;
  - assessment denominators, version isolation and window boundaries are correct;
  - synthetic exclusion and idempotent reruns;
  - tutor insufficient evidence versus a provider failure;
  - regeneration daily dedup and the queue cap.
- Unit tests:
  - the projection allowlist and leak scan;
  - sink HTTP semantics (fake server);
  - seek detection and classification;
  - search outcome classification;
  - replay and search aggregation from fixtures (citations, repeated seeks, and degraded outcomes excluded);
  - document mutations never touch the review fields;
  - regeneration mutation guards;
  - no web query references `contentSignal`.
- A fixture demonstration on an isolated database and fixture events shows:
  - a threshold-crossing assessment;
  - a replay signal;
  - a genuine no-result search;
  - an infrastructure failure that stays out.
  - All documents are labelled `fixture`.
- Checks:
  - `npm test` with and without `TEST_DATABASE_URL` (an isolated embedded Postgres);
  - `npm run typecheck` and `npm run lint`;
  - `npm run build`;
  - Studio `sanity schema validate` and `npm run build` in `studio/`;
  - typegen.
- Studio browser check of the populated and empty states, where a non-production dataset can be used.

## Manual tests

1. Start the isolated Postgres and run the migrations: `DATABASE_URL=<isolated> npm run db:migrate`.
2. `npm run outbox -- status` shows pending, claimed and failed counts. `npm run outbox -- dispatch --dry-run` prints the projected properties without sending.
3. `npm run signals -- aggregate --as-of 2026-09-14 --lookback 0 --events docs/editorial-signals/fixture-events.json --dry-run --out /tmp/signals.json` prints the four fixture signals and the excluded infrastructure counts.
4. In Studio, open Content signals → Open, pick a signal, and choose "Start investigating", then "Resolve". Rerun the aggregation: the status stays resolved.

## Implementation notes

Implemented on 2026-09-14 in `../vertex-pr-10` on `feat/pr-10-editorial-signals`, off `3de183e` (= `origin/feat/pr-7-lesson-integration`). The user's instruction was the approval bypass (see Approval). The user then directed a follow-up (below) and asked for a commit, a push and a draft PR against `feat/pr-7-lesson-integration`. Nothing is merged or deployed, and no job is scheduled.

### Follow-up directed by the user (2026-09-14)

1. **Raw query text removed from browser analytics.**
   - `search_performed` and `search_result_clicked` no longer send `query`. They keep `query_length`, status, counts, and result type and position.
   - No code in any branch reads `query`; `prompts/engagement-tracking.md` carries an amendment.
   - Still open: posthog-js pageviews record `/search?q=…` in `$current_url`. Not changed here; see "Needs a decision".
2. **The per-page remote flag request.**
   - Investigated with a probe of posthog-node 5.51.4 against a local fake PostHog. Creating the flag removes the remote `/flags` call only when three things hold: the flag is a plain percentage rollout, `POSTHOG_SECRET_KEY` is set, and the definitions have loaded.
   - A person-property condition, "persist across authentication", quota limiting or a missing secret each still cost about one round trip per evaluation.
   - A cold process also waits for the full definitions download before its first answer. `featureFlagsRequestTimeoutMs` does not bound that download.
   - Change:
     - The lesson page no longer evaluates `editorial-signals` while rendering; its PR-10 diff is now one `videoId` line.
     - The player reads the flag from posthog-js, whose flags already load in the browser on every page. It decides once per view, at the first play.
     - `/api/search` evaluates it locally only (`onlyEvaluateLocally`), after the response.
     - Guard tests pin all three.
3. **Replay denominator.** `video_played` now carries `seek_tracking`. Replay shares count only views with tracking on, so a partial rollout or late-loading flags cannot dilute them. The fixture adds 3 untracked plays: still 6 of 10.
4. **At-least-once, consistently.**
   - Every description now states at-least-once delivery with a stable event id, and says exactly-once is not claimed.
   - Resends are tested to carry the same `uuid`, `event`, `timestamp` and `distinct_id`, which are PostHog's deduplication fields.
   - PostHog documents that deduplication as eventual, done on ClickHouse merges, and not guaranteed. So both signal readers now keep one event per `uuid` (tested).
5. **Unsupported outbox events are held, not dead-lettered.** An event type with no projection is never claimed, sent, dead-lettered or marked delivered; it keeps its attempt budget, and `status` lists it as held.
   - PR-12's `submission_reviewed` now has a projection, built from its payload at `54ec90c`. It drops the submission, review and help-event ids.
6. **Review state across reruns, in a real dataset.** See the Studio item under "Verified".

### Verified

- **Tests:**
  - `npm test`: 638/638 pass with `TEST_DATABASE_URL` (isolated embedded Postgres 17 on :54336, in this session's scratchpad); 520/520 without it.
  - `npm run typecheck`, `npm run lint` and `npm run build` pass.
  - Studio: `sanity schema validate` reports 0 errors and 0 warnings; `tsc` and `sanity build` pass.
- **CLI, on the local `vertex_fixture_signals` database:**
  - `aggregate` raises one fixture signal per type and keeps the outages in the excluded counts:
    - v2 at 18/25;
    - replays at 1:30, 6 of 10 viewers;
    - 4 people searching `oauth refresh rotate token`;
    - tutor gaps on `lesson-reading`, 3 learners.
  - The outbox, against a local fake PostHog:
    - backoff on 503, then delivery;
    - the synthetic learner's events suppressed;
    - `submission_reviewed` sent with only its allowlisted fields;
    - an unprojected type held and pending.
- **Studio, populated, on the `demo` dataset (with the user's permission):**
  - Four `[Fixture]` signals were written by `npm run signals -- aggregate` and opened in a local Studio on :3339.
  - "Start investigating", "Acknowledge" and "Resolve" (from the document actions menu) set the status and stamped the reviewer and time.
  - A review note was added. One more fixture attempt changed v2 to 19/26, and the aggregation was rerun for the same window.
  - Counts and `computedAt` refreshed; the status, stamps and note were unchanged on all four.
  - The four ids were then deleted. `demo` matched its pre-test snapshot of ids and revisions (20 documents).
  - No PostHog was involved.
- **Context scope:** the live `vertex-search` Context filter excludes `contentSignal`.

### Not verified

- **Live PostHog, delivery or querying:** there is no personal API key (`query:read`) and no project id. The HogQL reader and the `/batch/` sink were exercised only against fakes, and **that does not prove the live integration**. When credentials exist, verify with explicitly labelled test events (`source`/`fixture`) in a non-production project or with a test distinct id.
- **The new browser and server events in a running app.** The flag does not exist, and :3000 was left alone.
- **`regenerate --execute`** against Sanity and OpenAI. It must stay disabled.
- **Migration 0007 on Supabase or `vertex_local`.** It has not been applied to either. The Supabase grant path is unverified, as for PR-4: the non-superuser `postgres` granting a role, and `SET LOCAL ROLE` through the pooler.
- **PostHog insights built on the removed `query` property.** Needs a personal key to list.

### Deviations (★ = changes behaviour or permissions)

1. ★ **New database role `vertex_signals_worker`** (NOLOGIN, no RLS bypass, no DELETE).
   - It reads `attempt_log`, `tutor_request` and the outbox, and writes the `editorial` schema.
   - It may update only the outbox delivery columns. The jobs use it through `SET LOCAL ROLE` on the owner connection.
2. ★ **The outbox `status` check constraint is replaced to add `suppressed`.** This is the only non-additive DDL; the values are a superset of the old ones.
3. ★ **Held, not dead-lettered.** Unsupported outbox event types stay pending and unclaimed. A payload that fails its schema is dead-lettered (`invalid_payload`).
4. ★ **Browser analytics changes:**
   - `search_performed` and `search_result_clicked` lose `query`;
   - `video_played`, `video_watch_depth` and `lesson_completed` gain `lesson_id` and `video_id`, whatever the flag;
   - `video_played` gains `seek_tracking`.
5. ★ **New `tutor_request.current_seconds`** (nullable), written by the tutor.
6. **Tutor gaps come from Postgres `tutor_request`, not PostHog.** It is the authoritative record, and outages never create rows.
7. **Search gaps use a new server event, `search_outcome`.** It sends at most six tokenized keywords, not scrubbed, and a fingerprint. It is flag-gated with local evaluation only.
8. **The seek flag is read in the browser, not on the server.** This avoids a per-view server-side flag request.
9. **No semantic clustering of questions.** Grouping is by term fingerprint, and by lesson for the tutor.
10. **Regeneration redrafts the whole generator unit** (a section's two items). It skips units with a pending draft or a newer version. Execution is off by default.

### Integration notes

- **Migration `0007_editorial_signals.sql`:**
  - it depends only on 0001 and 0002;
  - when merging with 0003–0006, take the union of `MIGRATIONS` and `TABLES` in `lib/db/migrate.db.test.ts`;
  - PR-8 (explain-back) was told to use 0008 or later.
- **Expected textual conflicts:**
  - `lib/flags.ts`;
  - `package.json` scripts;
  - `.env.example`;
  - `studio/sanity.config.ts`, `studio/structure.ts`, `studio/schemaTypes/index.ts`;
  - `sanity.types.ts` (rerun `npm run typegen`);
  - `components/lesson/video-embed.tsx` (#14 `ca953e3` rewrote its save logic);
  - `components/search/search-results.tsx`;
  - `lib/tutor/service.ts` (the insert column list).
- **Synthetic accounts:** label the demo and QA accounts with `npm run signals -- synthetic add <id> --label demo`. Their outbox events are then suppressed, and their attempts leave aggregates.
- **New outbox event types** (e.g. PR-8's): add a projection in `lib/outbox/projection.ts`. Until then they are held, never lost.
- **`--as-of`** stamps `computedAt` and the regeneration `queued_day` with the as-of date, not the wall clock.
- **Operations:** see `docs/EDITORIAL_SIGNALS.md`. Suggested schedules are documented but not enabled.

### Needs a decision

- **`$current_url` on `/search` pageviews** still carries the raw `q`. A posthog-js `before_send` that redacts `q` from `$current_url` and `$referrer` would close it. That is a global analytics change, not made here.
- **Flag creation:** `editorial-signals` at a percentage rollout only, no person, cohort or continuity conditions. Creating it is the user's shared-config call.
