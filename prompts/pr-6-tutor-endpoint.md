# PR-6: Time-anchored tutor endpoint

## Goal

Implement the sixth increment of `docs/Vertex_AI_Native_Development_Plan.md` (§5 PR-6): `POST /api/tutor`, which answers a learner's question about a lesson with bounded explanation text whose citations are resolved and validated by the server.

- Retrieval is time-anchored. It starts at the playhead and expands deterministically to the lesson, then to the course.
- The PR-5 help policy decides the help level. The model cannot change it.
- The model returns `SupportedFeedback`-shaped output (PR-0 contracts), with evidence refs only. The server keeps only refs it retrieved, and builds every time, label and link itself.
- The route ships behind a new flag `tutor`, plus `learner-evidence` and `help-policy`. There is no UI (that's PR-7).

The work is on branch `feat/pr-6-tutor-endpoint`, in worktree `../vertex-pr-6`, based on PR-5 `0cfb0a0` (#11). The PR base will be `feat/pr-5-help-policy`.

## Guidance read

- `AGENTS.md`:
  - §2 invariants: no whole transcripts, and grounding;
  - §3: this is a high-risk change because it adds a migration and a public AI route;
  - §8–§10, and §12–§13.
- `CLAUDE.md` approval rules.
- Development plan:
  - §2;
  - §3: authorization, the evidence envelope, and inference and operations;
  - §4: dependencies and flags;
  - §5 PR-0, PR-4, PR-5, PR-6 and PR-7, for the boundaries.
- `prompts/pr-5-help-policy.md`, including its implementation notes.
- Memory:
  - sign-in is required for the tutor, and flags are PostHog flags that fail closed;
  - learner queries only through `asLearner`;
  - OpenAI `gpt-5-mini` via `@ai-sdk/openai`;
  - Node 22 via nvm, and the embedded Postgres for DB tests.

## Code inspected (at `0cfb0a0`)

- **`lib/ai/contracts.ts`:**
  - `evidenceRefSchema`, `resolvedCitationSchema` (href must match `/lessons/<slug>?t=N`) and `supportedFeedbackSchema`, with bounded counts and lengths.
  - It says generation "arrives with its first consumer (PR-6 tutor)".
- **`lib/ai/gateway.ts`:** `generateBoundedObject`. It has:
  - a timeout;
  - one provider retry;
  - an output-token cap;
  - `AiCallError` with categories `timeout | provider_error | invalid_output`;
  - diagnostics with no raw text.

  Tests mock it with `MockLanguageModelV4` from `ai/test`.
- **`lib/ai/help-policy.ts`:** `decideHelpLevel({mode, request, currentLevel, ambiguous?})`.
  - Rule 2 (`ambiguous` → level 0) was left for PR-6.
  - The policy version is `help-v1`.
- **`lib/learner/help.ts`, `help-events.ts` and `app/api/help/route.ts`:** the PR-5 flow.
  - It uses `findOwnedTaskInstance`, `getInstanceHelpLevel`, `insertHelpEvent` (idempotent by `request_key`), `lockLearnerFamily`, and the `help_level_decided` outbox payload.
  - `help_event` already has a `session_id` column.
- **`lib/learner/http.ts` and `contracts.ts`:**
  - `readBoundedJson` (2 KB), `learnerJson` (`no-store`) and `failureResponse`, which maps `ContentUnavailableError` and database outages to 503 `unavailable`;
  - the strict request and response schemas and error codes.
- **`lib/evidence/chunks.ts`:** `toSourceChunks`, `chunkIdFor` (`<video _id>:<chunk _key>`) and `chunkRevisionOf` (a hash of start and text). Chunks come from `lib/video/ingest.ts` and are at most 30 s and 300 characters each.
- **`lib/search/terms.ts`:** `tokenize`, `fallbackTerms` and `countTermHits`.
- **`lib/search/queries.ts`:** the `orMatch` prefix-wildcard pattern and the `SAFE_TERM` check.
- **`lib/search/retrieve.ts`:** lesson↔video grounding via `parseVideoUrl(lesson.videoUrl).videoId`.
- **Sanity:**
  - `sanity/lib/client.ts` is the published-perspective server client, and `sanity/lib/fetch.ts` is `sanityFetch`.
  - `sanity/queries/lessons.ts` resolves the parent course through a reverse reference (the oldest course).
  - `sanity/queries/videos.ts` returns chapters only, never chunks.
  - `studio/schemaTypes/documents/video.ts` defines `durationSeconds`, `chapters` and `transcriptChunks`.
- **`app/lessons/[slug]/page.tsx`:** browsing is public, and `?t=` deep links go through `toStartSeconds`.
- **`lib/db/migrate.ts` and `db/migrations/0001_learner_evidence.sql`:**
  - forward-only migration files, with RLS `own_rows` policies and least-privilege grants;
  - the outbox is insert-only for `vertex_learner_app`, which has no DELETE anywhere;
  - `asLearner` sets a 5 s `statement_timeout`.
- **`lib/learner/help-route.db.test.ts`:** the module-hook route test pattern.
- **PR-2 (visual index) is not in this stack** (`68c2f25` is not an ancestor), so the tutor uses transcripts only.

## Decisions (recommended defaults, for approval)

1. **Retrieval is direct, parameterized GROQ through the published server client, not the Context MCP.**
   - Nothing here authors a query from model output, and the MCP's `vertex-search` scope is tuned for search. PR-4 and PR-5 read content the same way.
   - Terms are always passed as GROQ params, never inlined. The explicit `!(_id in path("drafts.**"))` and `versions.**` exclusions are kept, as in PR-4.
   - Chunk arrays are filtered and sliced inside GROQ (`transcriptChunks[startSeconds >= $from && startSeconds <= $to][0...N]`). A whole transcript is never fetched.
2. **Route contract: `POST /api/tutor`.** The body is strict Zod, at most 2 KB:
   - `lessonId`: a Sanity id.
   - `currentSeconds`: an integer from 0 to 86,400.
   - `question`: 3–500 characters after trimming.
   - `mode`: `study` or `reference`.
   - `helpRequest?`: `hint`, `escalate` or `solution`. It defaults to `hint`.
   - `sessionId?`: `[A-Za-z0-9_-]{8,64}`.
   - `taskInstanceId?`: a UUID.
   - `requestKey`: the existing idempotency pattern.

   **Deviation from the plan's route shape:** `requestKey` is added, so that a retry can never escalate help or double-record it. Any `level`, `userId` or history field is rejected.
3. **Authorization order.** Every rejection happens before any retrieval or model call.
   1. `auth()` → 401 when signed out.
   2. All three flags must be on (`learner-evidence`, `help-policy` and `tutor`). Otherwise the route returns 404 before any Sanity or database access, because disabling a prerequisite disables PR-6 (plan §4).
   3. The lesson must be a published `lesson` document → otherwise 404.
   4. `currentSeconds` must not exceed the video's `durationSeconds` (falling back to the lesson's `durationSeconds`). Otherwise the route returns 400 `invalid_request`. If neither duration is known, any value within the schema bound is accepted.
   5. With a `taskInstanceId`, the instance must be owned by the learner (checked under RLS) and its `lesson_id` must equal `lessonId`. Otherwise the route returns 404, and nothing is recorded.

   Access model, stated plainly: published lessons are public, and "free preview" is only a label. Being signed in plus a published lesson is the entitlement; there is no multi-tenancy to enforce.
4. **Retrieval tiers.** Each tier is a single deterministic pass with hard bounds.
   1. **`window`:** chunks of the lesson's video that overlap `[t − 90 s, t + 90 s]`, at most 14. This tier always runs.
   2. **`lesson`:** runs when fewer than 2 window chunks contain a question term (checked with `countTermHits` against `fallbackTerms(question)`). It adds same-video chunks outside the window that prefix-match any term, at most 8.
   3. **`course`:** runs when the window and lesson tiers together still have fewer than 2 matching chunks. It adds keyword-matched chunks from the other lessons of the parent course: at most 20 lessons, 3 chunks per video, 12 in total.
   - A course-tier chunk counts only when it resolves to a published lesson through `parseVideoUrl`. The citation then points at that lesson.
   - The response reports `scope` as the widest tier searched.
   - Overall caps: 30 chunks and 9,000 characters of chunk text.
   - A question with no content terms stays in the window, with no expansion.
   - The final chunk of a window gets its `endSeconds` from `toSourceChunks` on the fetched subset, which is `start + 30 s` capped at the video duration. That is accepted and documented.
5. **An ambiguous request is decided deterministically, never by the model.**
   - A request is ambiguous when the question has no content terms (search stopwords plus a small filler list: `help`, `please`, `this`, `that`, `it`, `idk`, `huh`, `confused`, `stuck`) **and** the window is empty.
   - Then the route returns `status: 'clarification_needed'` at level 0, with the reason `clarification_needed`, plus one server-written clarifying question. No retrieval beyond the window and no model call.
   - A short deictic question at a playhead that has transcript ("what does this mean?") is answered from the window.
   - The model's `followUp` is only a suggestion. It never changes the level or the status.
6. **How the help policy applies.** It goes through the unchanged `decideHelpLevel` (`help-v1`). Mode and request are passed through as in `/api/help`.
   - **With a task:** `currentLevel` is `getInstanceHelpLevel`, and the event is recorded on the instance, so its family is marked assisted for grading.
     - A tutor answer at level 3 records answer exposure even though the model never saw the answer key. This is conservative by design.
     - Help after submission or expiry is allowed, as in PR-5. It never changes a stored grade.
   - **Without a task:** progression is scoped to `sessionId` through a new `getSessionHelpLevel` (the maximum level where `session_id` matches and `task_instance_id is null`). With no `sessionId`, the level is 0.
     - `sessionId` is chosen by the client. It can only reset the ladder to level 1; the other ways to reach level 3 (`reference`, `solution`) are explicit anyway.
   - **The level shapes the system prompt:**
     - 1: direction, meaning where in the cited sources to look and one guiding question, without the full answer;
     - 2: name and explain the key concept;
     - 3: a complete explanation.
   - **Assessment content never reaches the tutor model.** That covers the question, the options, the hints and the answer key. The reviewed rungs stay with `/api/help`, and the tutor response has no `hint` field.
7. **Generation.**
   - The task is `tutor-answer`, with prompt version `tutor-v1`. The model is `gpt-5-mini` with reasoning effort `low`.
   - `maxOutputTokens` starts at 3,000. Its final value is set from live measurement and recorded in the file, following the search precedent.
   - The timeout is a new `TUTOR_TIMEOUT_MS`, 20,000 ms by default, read with `readTimeoutMs` and added to `.env.example`. The gateway's 10 s is tight for an explanation.
   - Output schema: `supportedFeedbackSchema` statements plus `kind: 'claim' | 'analogy' | 'connective'`, so generated analogies are labelled (plan §3).
   - **Zero output-repair attempts.** The plan allows at most one; this PR takes none.
   - **Prompt injection:**
     - Sources, the question and the lesson title go into the prompt as a JSON-encoded data block.
     - The inline system prompt states that they are untrusted data and must not be followed.
     - It holds the critical grounding rules and uses no template literals with backticks.
     - The Context document is not used.
8. **Validation and citations (server authority).**
   - Every `EvidenceRef` must match a retrieved chunk on **both** `chunkId` and `chunkRevision`; otherwise it is dropped.
   - **Relevance floor (a V1 heuristic):** a kept citation must share at least one content term with its statement (`countTermHits`).
   - A `claim` left with no citation is dropped. `analogy` and `connective` statements carry no citations.
   - Each `ResolvedCitation` is built only from stored records:
     - `lessonId`;
     - `sourceRevision`, set to `chunkRevision`;
     - start and end;
     - label `"<lesson title> · m:ss"`;
     - href `/lessons/<slug>?t=<start>`.

     It is parsed with `resolvedCitationSchema`.
   - **Status:**
     - `supported`: at least one cited claim survives and nothing was dropped.
     - `partial`: something was dropped, or the model itself said `partial`.
     - `insufficient_evidence`: no cited claim survives, the model said so, or retrieval returned zero chunks (in which case the model is not called).

     The server can downgrade the model's status but never upgrade it.
   - `insufficient_evidence` returns no statements and the fixed message: "I could not find enough supporting material in the course sources searched." It is never worded as "the course doesn't cover this".
9. **Transaction order.** The model call never runs inside a transaction, because of the 5 s statement timeout.
   1. **tx1** (`asLearner`):
      - replay check;
      - owned instance and lesson match;
      - the per-hour budget;
      - `currentLevel`.
   2. Decide the level.
   3. Sanity retrieval.
   4. The model call.
   5. Validate.
   6. **tx2** (`asLearner`):
      - with a task, `lockLearnerFamily`;
      - insert the `tutor_request` with `on conflict do nothing`;
      - if help was delivered, insert the `help_event` with the level decided in step 2;
      - write the outbox rows.

   Nothing is recorded when the model fails. A failed call must not mark a family as assisted with help that was never shown, and the role has no DELETE.

   **Documented consequence:** two concurrent tutor requests with *different* keys can record the same level. `/api/help` serializes the decision and the insert; the tutor cannot, because the model call sits between them.
10. **Storage: migration `0002_tutor_requests.sql`.** It is additive only.
    - It creates a new `learner.tutor_request` table with these columns:
      - `id`;
      - `learner_id`;
      - `request_key`, unique per learner;
      - `lesson_id`;
      - `task_instance_id`, a nullable foreign key;
      - `session_id`;
      - `help_event_id`, a nullable foreign key;
      - `status`, checked;
      - `scope`, checked;
      - `evidence_count`;
      - `cited_count`;
      - `prompt_version`;
      - `model_id`;
      - `created_at`.

      There is an index on `(learner_id, created_at)`.
    - It holds **no question or answer text**.
    - It has an RLS `own_rows` policy and grants `select, insert` to `vertex_learner_app`, and it repeats 0001's Data API revoke block.
    - **Why a table is needed:**
      - The plan requires recording the scope searched.
      - It requires a per-user budget, and `insufficient_evidence` calls also cost a model call but record no `help_event`.
      - The outbox is write-only for the app role, so it cannot be counted.
    - **Budget:** 30 tutor requests per learner per rolling hour, counted in tx1 → 429 `rate_limited` (retryable).
      - Concurrent requests that are already in flight can overshoot it slightly. This is documented.
      - Model failures are not counted.
    - **Replay:** a `requestKey` that already has a `tutor_request` returns 409 `already_answered`.
      - Answers are not stored, so the tutor keeps no private text and there is no retention question.
      - A client that lost the response asks again with a new key and `helpRequest: 'hint'`. The policy then repeats the current level (`repeat_current`) and never escalates.
      - A key already used for a `help_event` from `/api/help` returns 409 `idempotency_key_reused`.
11. **Outbox.** Payloads carry ids and enums only; there is still no dispatcher.
    - `help_level_decided`: PR-5's payload plus `sessionId`, written only when a `help_event` is recorded.
    - `tutor_answered`:
      - `tutorRequestId`
      - `learnerId`
      - `lessonId`
      - `taskInstanceId`
      - `helpEventId`
      - `status`
      - `scope`
      - `evidenceCount`
      - `citedCount`
      - `promptVersion`
12. **Response** (a strict Zod schema that is also parsed on the server):

    ```
    {tutorRequestId, status, scope, statements: [{text, kind, citations: ResolvedCitation[] ≤4}] ≤8,
     followUp?, message?, help: {helpEventId, level, reasonCode, policyVersion} | null}
    ```

    - `help` is null for `insufficient_evidence`, because no help was delivered.
    - The response is sent with `Cache-Control: no-store`.
13. **Failures.**
    - These return 503 `unavailable` (retryable), with nothing recorded:
      - a provider error, timeout or invalid output (`AiCallError`);
      - a Sanity read failure (`ContentUnavailableError`);
      - a retryable database failure.
    - An outage is never reported as `insufficient_evidence`.
    - A missing `OPENAI_API_KEY` returns 503. The tutor has no deterministic fallback.
    - The code keeps retrieval (a content-source port), generation (an injected model) and recording apart, so each can be tested without Next. The Sanity implementation is `server-only`.
14. **Live evaluation harness.**
    - `scripts/eval-tutor.mts` runs retrieval, generation and validation against live Sanity and OpenAI, with no database, for the cases in `scripts/tutor-eval-cases.json`. It prints each case's status, scope, cited lesson and time, and statements for human review.
    - It covers these case types:
      - answerable local questions;
      - answers elsewhere in the lesson;
      - true out-of-scope questions;
      - a wrong-but-existing citation;
      - injected text;
      - inaccessible content.
    - I draft the cases from live transcripts, read-only, and mark them `reviewed: false`. **They count toward the pilot gate only after you review them.**

## Expected files

- **New:**
  - `lib/ai/tutor.ts` and its `.test.ts`: prompt construction, output schema, validation and status.
  - `lib/tutor/retrieve.ts` and its `.test.ts`: tiers and bounds.
  - `lib/tutor/source.ts`: the content-source port.
  - `lib/tutor/sanity-source.ts`: `server-only`.
  - `lib/tutor/service.ts`: orchestration and both transactions.
  - `lib/tutor/tutor.db.test.ts`.
  - `lib/tutor/tutor-route.db.test.ts`.
  - `app/api/tutor/route.ts`.
  - `sanity/queries/tutor.ts`.
  - `db/migrations/0002_tutor_requests.sql`.
  - `scripts/eval-tutor.mts` and `scripts/tutor-eval-cases.json`.
- **Modified:**
  - `lib/flags.ts` (`FLAGS.tutor`);
  - `lib/learner/help-events.ts` (`getSessionHelpLevel`);
  - `lib/learner/contracts.ts` (tutor request and response schemas, plus `rate_limited` and `already_answered`);
  - `lib/learner/http.ts` (their statuses, with `rate_limited` retryable);
  - `lib/timeouts.ts` (`TUTOR_TIMEOUT_MS`);
  - `.env.example`;
  - `sanity.types.ts` (TypeGen);
  - `package.json` (an `eval:tutor` script only).
- **No** change to the Studio schema, the help policy or its version, or dependencies.

## Security considerations

- The learner id comes only from `auth()`. All learner reads and writes go through `asLearner` under RLS.
- The client supplies no level, history, timestamp, title or URL. Citations are built from stored records.
- The model sees only published transcript chunks of the authorized lesson and course, never assessment content. Its refs are checked against the retrieval allowlist.
- No question, answer or chunk text goes to PostHog, logs, the outbox or `tutor_request`. The question text goes only to OpenAI, which PR-7 must disclose in the UI.
- Bounded body, question, chunks, characters, output tokens and timeout, plus a per-learner budget.

## Acceptance (each mapped to a named test)

- **Pure** (`lib/ai/tutor.test.ts`, `lib/tutor/retrieve.test.ts`; no network, using `MockLanguageModelV4`):
  - the window boundaries at 0 s and at the duration;
  - the expansion triggers and caps;
  - the character cap;
  - the ambiguity pre-check;
  - the level-specific system prompts;
  - refs with an unknown id, a mismatched revision, or pointing outside the allowlist are dropped;
  - a citation failing the relevance floor is dropped;
  - all refs invalid → `insufficient_evidence`;
  - the model's status cannot be upgraded;
  - a source chunk containing "ignore previous instructions…" is still JSON-encoded data, and the refs stay constrained;
  - citation hrefs and labels are built from records;
  - a provider error, timeout or invalid output → a retryable failure, not `insufficient_evidence`;
  - zero chunks → no model call.
- **Contracts:** a forged `level`, `userId` or `helpLevel` is rejected. The response schema has no hint, answer-key or raw-source field.
- **Database** (`tutor.db.test.ts`, `TEST_DATABASE_URL`, running as `vertex_learner_app`):
  - another learner's instance → 404 with nothing recorded;
  - a lesson mismatch → 404;
  - replaying the same key → 409 with no second model call and no escalation;
  - session-scoped study help goes 1 → 2 → 3;
  - a new session restarts at 1;
  - a task-bound answer marks grading assisted (level 3 → `answer_exposed`);
  - a model failure records nothing;
  - `insufficient_evidence` records a `tutor_request` but no `help_event`;
  - the budget → 429;
  - outbox rows have ids and enums only;
  - migration 0002 applies after 0001, and its RLS isolates learners.
- **Route** (`tutor-route.db.test.ts`, module hooks as in PR-5): a signed-out request → 401. With any of the three flags off → 404, with no content or database access. With the flags on, the stubs are reached.

## Checks

- Under Node 22, run:
  - `npx next typegen`, which a fresh worktree needs;
  - `npm run typecheck`;
  - `npm run lint`;
  - `npm test`, with `TEST_DATABASE_URL` pointing at the local embedded Postgres 17;
  - `npm run build`, because this adds a route.
- `npm run eval:tutor` runs against live Sanity and OpenAI, read-only, and its output is reported as it is.
- **Nothing** runs against Supabase or production. No migration is applied outside the local test database, and nothing is deployed.

## Manual tests (after the Supabase prerequisites from #10)

Signed in, with all three flags on, `OPENAI_API_KEY` set, and a lesson whose video has ingested transcript chunks:

1. `POST /api/tutor` with a question about the content at the playhead → `supported` or `partial`, `scope: 'window'`, and citations whose `href` opens the lesson at those seconds.
2. A question answered elsewhere in the lesson → `scope: 'lesson'`, with a cited time outside ±90 s.
3. An off-topic question → `insufficient_evidence` with the fixed message.
4. Study mode with one `sessionId`: `hint` → level 1, `escalate` → 2, then `escalate` → 3. Reference mode → level 3.
5. Replay a key → 409 `already_answered`.
6. Signed out → 401. With `tutor` off → 404.

## Rollback

Turn off `tutor`, and `/api/tutor` returns 404. Search, playback, `/api/help` and grading are unaffected. The `tutor_request` and `help_event` rows stay. Migration 0002 is additive and is not reversed.

## Not in this PR

- The UI, citation seeking and analytics events: PR-7.
- Visual evidence: PR-2 is not in this stack.
- LLM query interpretation for the tutor.
- Answer caching.
- An outbox dispatcher (see #10).
- Supabase verification (outstanding from #10).

## Implementation notes (2026-09-13)

These differ from, or go beyond, the plan above:

- **Expansion rule.** A tier stops the search only when it holds a *strong* match: a chunk containing two question terms, or the only term.
  - The planned rule was "fewer than 2 window chunks with any term". On live transcripts, a single incidental word ("contextually") stopped a context-window question at lesson scope.
  - With no course lessons, the widest scope reported is `lesson`.
- **Query location.** The GROQ queries live in the framework-free `lib/tutor/source.ts` (`createGroqTutorSource`), which the Sanity source and `scripts/eval-tutor.mts` share. They are not in `sanity/queries/tutor.ts`, so `sanity.types.ts` is unchanged.
- **Terms.** `contentTerms` (in `lib/ai/tutor.ts`) removes search stopwords and a tutor filler list, and strips a plural `s`. `lib/search/terms.ts` now exports `STOPWORDS`, and search behaviour is unchanged.
- **Migration constraint.** 0002 also checks that `help_event_id` is null exactly for `insufficient_evidence`.
- **Existing DB tests.** Their `truncate` lists now include `learner.tutor_request`, because its foreign keys block truncating the referenced tables. `migrate.db.test.ts` and `rls.db.test.ts` cover the new table.
- **Prompt tightened once after the first live evaluation.**
  - Each claim must be stated in its cited sources.
  - Level 1 explains nothing.
- **Output-token budget.** `TUTOR_MAX_OUTPUT_TOKENS` is 2,000. The measured maximum was 847 output tokens at `low` effort.
- **Latency.** p50 was 8–10 s, and the maximum was about 12 s, under the 20 s timeout.
- **Live evaluation (all cases `reviewed: false`): 8/9 met their structural expectations.**
  - `wrong-citation-downsides` fails. Retrieval is window-first and lexical, so it never reaches the lesson's cons section (5:41–6:14). The answer instead restates nearby temperature chunks and is labelled `supported` rather than `partial`.
  - Level 1 still states the conclusion, only phrased as "the lesson states…".
  - One level-2 claim added "nonsensical tokens", which its cited chunk doesn't say. The lexical relevance floor cannot catch this.
  - The pilot gate (plan: no known unsupported critical claim) is **not met**.
- **Test fixture.** `lib/tutor/test-source.ts` holds the shared fixture: content plus mock models that read the prompt's sources.

## Follow-up (2026-09-13)

- Draft PR #12 has a follow-up: `prompts/pr-6-eval-fixes.md` fixes the evaluation findings (term expansion with chapter-first retrieval, a model support check, and a pointer-only level 1). Run 2's evaluation is in `docs/evals/`.
- **OCR/VLM evidence is not integrated.** PR-2 (`68c2f25`) is not in this stack, so the tutor is transcript-only.
- **Learner evidence and mastery don't depend on the missing outbox dispatcher.** Each is written in the same transaction as its outbox row, and nothing reads the outbox. Only delivery of those events to analytics and PR-10 depends on a dispatcher.

## Follow-up 2 (2026-09-13)

See `prompts/pr-6-citation-retrieval-review.md` for the details.

- **Gate 2b (`uncited_source`)** drops claims whose wording sits in an uncited chunk. The run-2 nucleus pairing (4:47 wording cited to 5:04 and 6:36) is a regression test.
- **Retrieval** uses deterministic terms: the learner's words plus a fixed pros/cons word list. The `tutor-terms-v1` model call was compared and removed (`docs/evals/pr-6-tutor-comparison.md`).
- **Hit neighbours** are added, and a chapter that lies entirely inside the window no longer uses a slot.
- **Prompt version** is now `tutor-v3`.
- **Evidence:** run 3 and the human review packet are in `docs/evals/`.
- **OCR/VLM** is follow-up issue #13.
