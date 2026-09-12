# PR-1 pre-commit verification and fixes

## Goal

Close PR-1's remaining gaps before it is committed:

- browser smoke tests of the Studio review/publish flow;
- a deterministic generation record for every processed section, so reruns never call the model again for sections already processed (including sections with zero candidates or only rejected candidates);
- pressure tests for the hint-leak heuristic;
- a ≥20-candidate dry-run audit across the pilot course;
- proof that the learner projection never exposes private fields;
- a full re-run of all checks.

No deploy, no production assessment writes, no commit, no push, and none of the pre-existing UI changes.

## Guidance read

- `AGENTS.md` §2, §12, §13; `prompts/pr-1-reviewed-assessments.md`; development plan §3 (data ownership: Sanity owns "draft generation results"), §5 PR-1.

## Code and environment inspected

- `scripts/generate-assessments.mts`, `lib/assessments/{generate,spans,staleness,learner}.ts`, `sanity/queries/assessments.ts`, `studio/{sanity.config,structure}.ts`, `studio/schemaTypes/documents/assessment.ts`, `studio/actions/assessment-publish.ts`.
- Sanity project: the **only dataset is `production`**. CORS already allows `http://localhost:3333`, and a CLI login session exists (`~/.config/sanity/config.json`).
- Local tooling: cached Playwright Chromium, Google Chrome, and `groq-js@1.30.3` (currently only a transitive dependency). `sanity/queries/assessments.ts` imports cleanly under `node --test`.
- Pilot course (proposed): `practical-web-security`, 12 lessons, all with YouTube transcripts.
- No learner API route for assessments exists (PR-4/PR-7 add them). The GROQ projection plus `toLearnerAssessments` is the response boundary those routes will return.

## Decisions

### 1. Browser smoke test (blocked: requires your choice)

Recommended: a throwaway private dataset `pr1-smoke`.

- Create it and import a copy of one lesson plus draft assessments built from dry-run output.
- Run the Studio locally against it (`SANITY_STUDIO_DATASET=pr1-smoke npx sanity dev`).
- Drive it with headless Chrome through `playwright-core`, installed in the session scratchpad and not in the repo.
- Authenticate by placing the existing CLI session token in the local Studio's `localStorage` (`__studio_auth_token_<projectId>`), which stays on this machine.
- Delete the dataset afterwards.

Nothing touches `production` or its assessments. Alternatives: you run the checklist yourself, or a view-only check against `production`. The view-only check cannot test the publish flow, because the first edit writes a draft.

Checklist (screenshots saved to the scratchpad):

1. An assessment draft renders, with all groups (Item, Review, Source, Generation) and the source excerpt.
2. Publish is disabled with the "Set the review status to Approved" reason while the item is `needs_review`.
3. Setting Approved with one check unticked shows a validation error, and Publish stays disabled ("Complete every review check").
4. With all six checks ticked, Publish is enabled. Publishing succeeds in `pr1-smoke`.
5. After approval, content fields are read-only. Editing is blocked; if a changed draft of an approved published item is forced, its Publish button is disabled ("immutable").
6. Authoring presentation (my reading of "learner-facing fields don't appear incorrectly"):
   - the answer key and hints are labelled private;
   - source refs, excerpt, generation metadata and response format are read-only;
   - generation records are read-only and never offer Publish of an assessment.

### 2. Generation records (idempotency)

- New Sanity document type `assessmentGenerationRecord`, with id `assessment-generation-<spanKey>`.
- `spanKey` is the existing key: section identity (lesson id + video document id + ordered `chunkId@chunkRevision` list) + prompt version + model + generator config version.
- Fields: `lesson` ref, `spanIndex`, `spanKey`, `promptVersion`, `model`, `configVersion`, `outcome` (`drafted | no_candidates | all_rejected`), `draftIds[]`, `rejectionReasons[]`, `modelSkipReason`, `processedAt`.
- A record is written in the **same transaction** as that section's drafts, whenever the model returned a schema-valid response.
- It is not an `assessment`:
  - the learner query filters `_type == "assessment"`;
  - the Context MCP type allowlist excludes it;
  - the Studio shows records read-only, with no publish action. Records are plain documents, never assessment drafts or published assessments.
- Reruns skip any section with a record, or with an assessment carrying the same `spanKey` (for pre-record drafts). `--force` reprocesses anyway: assessment versions still increment, and the record is replaced with the new outcome.
- **Not recorded, so retried next run:** provider errors, timeouts, invalid output, and run-cap deferrals. These failures are not deterministic.
- The orchestration moves into a framework-free `lib/assessments/pipeline.ts` (`processLesson` with an injected `generate` function and returned mutations). The CLI keeps only I/O, so tests can count model calls.
- Alternative rejected: a local ledger file. It is not shared or durable across machines and would diverge from Sanity state.

### 3. Hint leakage

- Keep the verbatim and overlap guards.
- Add tests:
  - morphological and reordered paraphrases are caught;
  - pure-synonym paraphrase is **not** caught (a named known-limitation test);
  - false positives are avoided when a hint shares domain terms or distractor words;
  - answers under 3 content words skip the overlap check.
- Only extend the stem suffixes (e.g. `ly`) if a real paraphrase case needs it.
- Code, docs and the Studio check title will state that the check is a heuristic, not semantic safety.
- The Studio `hintsProgressive` check becomes "Hints 1–2 neither state nor paraphrase the answer (automated check is heuristic only)".
- Human approval stays mandatory; the gated publish is unchanged.

### 4. Candidate audit

- Run `npm run generate:assessments -- --course practical-web-security --dry-run --out <scratchpad>` with the final code. This takes roughly 40–60 model calls, runs in the background, and writes nothing.
- Review every candidate against its source excerpt, recording:
  - accepted/rejected counts and rejection reasons;
  - answer correctness;
  - source grounding;
  - hint leakage;
  - question wording that reveals the answer.
- Save the results as `prompts/pr-1-candidate-audit.md`, labelled a **preliminary AI review**, not the subject-matter review the plan's learning gate requires.

### 5. Learner exposure test

- Add `groq-js@1.30.3` as a devDependency (already installed transitively; no new download).
- New `lib/assessments/learner-query.test.ts` evaluates the real `LESSON_PRACTICE_ITEMS_QUERY` over fixture documents: approved/current/published, stale, needs_review, drafts, and another lesson.
- It asserts that only eligible rows return, with exactly the allowlisted keys.
- It also asserts that no serialized output contains any of: `answerKey`, `correctOptionId`, `correctOptionIndex`/answer index, `hints` (or hint text), `sourceExcerpt` (or transcript text), `sourceChunkRefs`, `review`, `reviewStatus`, or `generation`.
- The same check also runs, via a scratchpad script, over every dry-run candidate treated as approved.

## Expected files

New: `lib/assessments/pipeline.ts`, `lib/assessments/pipeline.test.ts`, `lib/assessments/learner-query.test.ts`, `studio/schemaTypes/documents/assessment-generation-record.ts`, `prompts/pr-1-candidate-audit.md`.

Modified: `scripts/generate-assessments.mts`, `lib/assessments/generate.ts` (+ `.test.ts`), `studio/schemaTypes/{index.ts,documents/assessment.ts}`, `studio/structure.ts` (read-only "Generation records" list), `package.json` + `package-lock.json` (groq-js devDependency), `sanity.types.ts` (TypeGen), `docs/DATA_MODEL.md`, `prompts/pr-1-reviewed-assessments.md` (Decisions 4 and 13, manual test 4).

Untouched: all pre-existing modified UI files.

## Acceptance criteria

- A pipeline test shows a section with a `no_candidates` or `all_rejected` record makes **zero** `generate` calls. With `--force` it makes one. A provider failure writes no record and is retried.
- A record and its drafts appear in one transaction's mutations. A record is never `_type: "assessment"` and never uses a `drafts.` id.
- Hint tests are as listed in §3, and the known limitation is explicit.
- The learner-query test passes, and the audit file covers ≥20 candidates.
- Browser checklist 1–6 passes (or the findings are reported).

## Checks

Node 22: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm --prefix studio run typecheck`, `npm --prefix studio run schema:validate`, `npm run typegen`.

## Rollback

All changes are additive and uncommitted. `pr1-smoke` is deleted after the smoke test. Generation records are never written during verification, because all runs are dry runs.
