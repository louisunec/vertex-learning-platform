# PR-1: Reviewed assessments and hint ladders (offline generation)

## Goal

Second increment of `docs/Vertex_AI_Native_Development_Plan.md` (§5 PR-1):
an offline generator that drafts single-choice practice items with a
three-level hint ladder from bounded transcript spans, a Sanity `assessment`
type with an editorial review workflow, and a learner-safe projection that
never carries answers, hints, or source text. No learner route, UI, grading,
or attempts. Those are PR-4 and PR-7.

## Guidance read

- `AGENTS.md` §2, §7, §8, §10, §12; `docs/VIDEO_PIPELINE.md` §6, §12, §13;
  `docs/DATA_MODEL.md`.
- Development plan §3 (data ownership, authorization, evidence envelope,
  versioning, inference limits), §4, §5 PR-1, §6 release gates.
- `prompts/pr-0-grounded-ai-contracts.md` (gateway, contracts, test conventions).

## Code inspected

- Studio: `schemaTypes/{index,documents/video,documents/lesson,documents/progress,objects/transcript-chunk,objects/chapter,objects/learning-outcome}.ts`,
  `structure.ts`, `sanity.config.ts`, `package.json`.
- Pipeline: `scripts/ingest-videos.mts`, `lib/video/{ingest,provider}.ts`.
- AI: `lib/ai/{gateway,contracts}.ts`, `lib/search/interpret.ts`, `lib/flags.ts`, `lib/timeouts.ts`.
- Data: `sanity/lib/{client,fetch}.ts`, `sanity/queries/{lessons,videos}.ts`,
  `studio/scripts/context/search-context.ndjson`, `lib/search/queries.ts`.
- Live dataset (read-only): 10 courses × 12 lessons; video docs carry 10–130
  transcript chunks, and many have no chapters. An unauthenticated query returns
  0 documents, so the dataset is **private**.

## Decisions and assumptions

1. **Bounded spans, never whole transcripts, even offline** (AGENTS.md §2).
   One model call per span. A span follows chapter boundaries where
   chapters exist, otherwise fixed windows of 10 chunks. Hard cap: 12 chunks
   per span (≈3,600 chars at `MAX_CHUNK_CHARS` 300). Longer chapters are
   split, and a trailing window under 3 chunks merges into the previous span
   if it stays within the cap. Each call yields at most 2 items and may
   legitimately yield 0, for example when the span is administrative, incomplete, or
   unsupported.
2. **Shared chunk identity contract (first definition; PR-2/3/6 must import
   it).** New framework-free `lib/evidence/chunks.ts`:
   - `chunkId = "<videoDocumentId>:<chunk _key>"` (e.g. `video-youtube-abc:tc-42-3`)
   - `chunkRevision` = first 16 hex chars of sha256(`startSeconds\ntext`)
   - `endSeconds` = next chunk's start; for the last chunk,
     `min(durationSeconds, start + MAX_CHUNK_SECONDS)`, or `start + 30` if no
     duration is stored.
   Computed from stored records, so the `video` schema is unchanged and no
   re-ingestion is needed. Re-ingested identical captions keep their revisions,
   and changed text changes the revision. An index shift changes the `_key`,
   which conservatively reads as stale.
3. **Model never authors chunk ids.** The prompt labels chunks `c0…cN`, the
   model returns indices, and the server maps them through the span's allowlist.
   Out-of-span indices drop the item.
4. **Generation key (deviation from plan wording, stated deliberately).** Plan
   §5 lists span/objective/type/ordinal. With one call per span, objective and
   type are model outputs, so the pre-call `spanKey` =
   sha256(lessonId, videoDocumentId, ordered `chunkId@chunkRevision` list,
   promptVersion, model, generator config version). Idempotency is at span
   level. *Revised in pre-commit verification:* every processed span gets an
   `assessmentGenerationRecord` (outcome `drafted | no_candidates |
   all_rejected`), written atomically with its drafts, and reruns skip recorded
   spans unless `--force` is passed. Provider failures are not recorded and are
   retried. See `prompts/pr-1-precommit-verification.md`. Each item records `generation.inputHash`
   = sha256(spanKey, ordinal), plus objective/type as reviewed fields.
5. **Family and version.** `familyId = asm-<sha8(lessonId)>-s<spanIndex>-q<ordinal>`.
   Document `_id = assessment-<familyId>-v<version>`. When a span's `spanKey`
   changes, the new candidates become `version = latest + 1` of the same
   families. Old versions are never overwritten or deleted. *Revised in the
   quality follow-up:* an unpublished latest draft is replaced in place (same
   id) rather than gaining a version beside it. Only a published version gets
   `latest + 1`, and published versions are never written. `--force` also
   deletes the unit's unpublished drafts that the new output does not
   reproduce. The lesson's transfer item uses the family
   `asm-<sha8(lessonId)>-t-q0`. See `prompts/pr-1-quality-followup.md`.
6. **Publish state vs review status.** The generator writes `drafts.`-prefixed
   documents (`createOrReplace` since the quality follow-up), so the published perspective excludes
   them. The primary gate is the Studio's native publish. `reviewStatus`
   (`needs_review | approved | rejected | archived`) is a separate field.
   The learner query also filters `reviewStatus == "approved"` as a second
   check.
7. **Gated publish.** `sanity.config.ts` `document.actions` wraps the default
   publish action for `assessment`. It is disabled unless the draft is
   `approved` with every review check true, or `archived`. Studio validation also makes
   `approved` require all checks. Review checks: `correct`, `unambiguous`,
   `distractorsPlausible`, `sourceSupported`, `difficultyAppropriate`,
   `hintsProgressive`, plus an optional reviewer note. (Verify the v5 action
   wrapping shape in `studio/node_modules/sanity` before writing it.)
8. **Immutability, and its limits.** Once `reviewStatus == approved`, content fields
   are `readOnly` in Studio. Only `reviewStatus` and `sourceStatus` stay
   editable, which is what makes stale-marking a published version legitimate.
   Sanity cannot enforce this at the API level: an Editor token can still patch.
   PR-4 will record `_id` + `_rev` per attempt so later mutation is detectable.
   Changing an approved item means generating or authoring a new version.
9. **Staleness.** Every generator run recomputes chunk revisions for each
   lesson in scope. Any version (draft or published) whose `sourceChunkRefs`
   no longer match gets `sourceStatus: "stale"` via patch. The learner query
   excludes stale items, and the Studio lists them for reconciliation.
10. **Answer-key isolation.** The dataset is private, but the app's read token
    is Editor-grade (memory, 2026-09-09). The **learner projection is
    therefore the only barrier**. The answer lives in a separate top-level
    `answerKey {correctOptionId, explanation}`, not a per-option flag. *Revised
    in `prompts/pr-1-structured-explanations.md`:* `explanation` is replaced by
    `correctReason` plus `distractorReasons[] {optionId, reason}`.
    `hints`, `answerKey`, `sourceExcerpt`, and `generation` are never
    projected. A `.strict()` Zod learner schema rejects any extra key, tested
    against a fixture containing `answerKey`/`hints`. *Added in pre-commit
    verification:* `lib/assessments/learner-query.test.ts` evaluates the real
    GROQ string with `groq-js`.
11. **MCP/search exclusion.** The Context MCP `groqFilter` is a type allowlist
    (`course, lesson, video, instructor, category`) and every search GROQ query
    filters `_type`, so `assessment` is excluded without changes. This is verified
    live in manual test 6.
12. **Stable option IDs** are the option array items' `_key`s (preserved on
    reorder). `answerKey.correctOptionId` must match one. Items have 3–4
    options, exactly one correct, and no duplicate options after normalization.
    *Revised in the quality follow-up:* options are stored in a seeded-shuffle
    order (seed = document id + input hash), and option ids derive from the
    option text. No answer index is stored. Candidates are also rejected for
    generator language (`generator_language`), for naming options by position
    (`positional_reference`), and for a conspicuously longer correct option
    (`answer_length_cue`).
13. **Hint leak check** (framework-free, generator side): hints 1–2 must not
    contain the normalized correct-option text or answer-revealing phrases
    ("the answer is", "correct option"). *Added during implementation:*
    they also must not reuse 60% or more of the correct option's content-word stems,
    because the first live dry run showed level-2 hints paraphrasing the answer.
    The prompt rule was tightened too. Leaky candidates are dropped and
    reported. The check is lexical only: synonym paraphrases pass it (a named
    test documents this), so human approval of the hints check is the gate. Studio repeats a minimal normalized-substring check as a
    validation error on edited hints 1–2. This is a ~10-line duplicate, because the Studio
    workspace cannot import web `lib/`.
14. **`sourceExcerpt`** (read-only, editorial only) stores the span text the
    item was generated from (≤3,600 chars), so reviewers can check source
    support. It is never projected to learners.
15. **Types and labels.** `type: recall | apply | transfer` are coverage targets,
    not quotas. *Revised in the quality follow-up:* section calls write recall
    or apply items. Each lesson gets one transfer call, over the span with the
    most chunks (ties go to the middle one), recorded as a `lesson_transfer`
    generation record. `responseFormat: single_choice` only. The schema description
    labels these as recognition/application evidence, not proof of
    unconstrained recall or transfer.
16. **`conceptRefs` omitted.** No `concept` type exists. PR-3 adds the field and
    backfills reviewed associations.
17. **No feature flag.** PR-1 has no request-path surface. The gates are the
    manual CLI invocation and Studio publish. The practice flag arrives with
    its first consumer (PR-7). No speculative `FLAGS` entry.
18. **Model.** OpenAI `gpt-5-mini` via the existing `generateBoundedObject`,
    `reasoningEffort: 'medium'`, explicit `timeoutMs: 90_000` (the 10 s
    gateway default is a search-latency bound), `maxOutputTokens: 6000`, and at most one
    provider retry (gateway). No output repair. Invalid output skips the span
    with a reason code. Each doc records model, prompt version, and config version.
    The gateway logs diagnostics with no raw text.
19. **Credentials.** Reads use `SANITY_API_WRITE_TOKEN`, falling back to
    `SANITY_API_READ_TOKEN` (the dataset is private). Writes require
    `SANITY_API_WRITE_TOKEN`, as in `ingest:videos`. `--dry-run` writes nothing.
20. **Scope flags.** `--course <slug>` or `--lesson <slug>` is required, so no
    whole-dataset run happens by accident. Also supported: `--limit N` (lessons), `--dry-run`, and `--out <file>`
    (dry-run candidates as JSON for the ≥20-item audit).
21. **Latest version per family.** The learner helper keeps only the highest approved,
    non-stale version per `familyId`.
22. Paths follow repo conventions (`scripts/<name>.mts`, `lib/<area>/`), not
    the plan's suggested `scripts/pipeline/generateAssessments.ts`.

## Expected files

New:
- `studio/schemaTypes/documents/assessment.ts` (options, hints, answerKey,
  review, sourceChunkRefs, generation as inline objects)
- `lib/evidence/chunks.ts` + `.test.ts`: chunk id/revision/end time, span key
- `lib/assessments/spans.ts` + `.test.ts`: bounded span builder
- `lib/assessments/generate.ts` + `.test.ts`: model-output schema, prompt
  builder, candidate → draft mapper, allowlist, option/hint checks
- `lib/assessments/staleness.ts` + `.test.ts`: stale detection, citation
  resolver returning PR-0 `resolvedCitationSchema` objects
- `lib/assessments/learner.ts` + `.test.ts`: strict learner schema, latest
  version per family
- `sanity/queries/assessments.ts`: learner-safe projection
- `scripts/generate-assessments.mts`

Modified:
- `studio/schemaTypes/index.ts`, `studio/structure.ts` (Assessments lists: needs
  review / approved / stale / rejected+archived), `studio/sanity.config.ts`
  (gated publish)
- `package.json` (`generate:assessments` script), `.env.example`
  (write-token comment), `docs/DATA_MODEL.md` (assessment section),
  `sanity.types.ts` (TypeGen output)

All `lib/` modules are framework-free with relative `.ts` imports (no `@/`, no
`server-only`), so `node --test` and the `.mts` script can load them.

## Requirements

1. The span builder is deterministic and bounded (≤12 chunks). It is
   chapter-aligned when chapters exist and otherwise uses windows, with merge rules as in Decision 1.
2. The generator validates model output with Zod (bounded lengths: question ≤400,
   option ≤200, hint ≤500, objective ≤200, explanation ≤800; ≤2 items per span).
3. The candidate mapper rejects out-of-span chunk indices, <3 or >4 options, duplicate
   options, a missing correct option, and leaky hints 1–2, each with a reason code.
4. Reruns with unchanged inputs write nothing ("0 new, N skipped").
5. A changed source revision creates version N+1 drafts and marks the prior
   versions `stale`. Nothing is ever deleted. *Revised in the quality
   follow-up:* an unpublished latest draft is replaced in place, and `--force`
   deletes unreproduced unpublished drafts. Published versions are never
   written or deleted.
6. The learner projection returns only
   `_id, _rev, familyId, version, lessonId, type, responseFormat, question, options[]{id, text}`
   for published, `approved`, non-stale items.
7. The citation resolver builds `/lessons/<slug>?t=<start>` citations from
   current video/lesson records and returns `stale` for unmatched refs.

## Security

- No new browser-exposed values, and no new routes.
- Answer keys, hints, source excerpts, and generation metadata are excluded by
  explicit projection plus a strict schema. The MCP allowlist excludes the type.
- Transcript text is treated as untrusted data. The system prompt instructs the model to
  ignore embedded instructions. Model output is schema-parsed, and chunk refs are
  allowlisted.
- Writes use only `SANITY_API_WRITE_TOKEN` in offline tooling.

## Acceptance criteria

- Unit tests cover span bounds, chunk-revision stability and change, out-of-span
  refs, option/answer validation, hint leaks, the zero-item span, span-level
  idempotency, version increment, staleness, citation resolution, strict
  learner-schema rejection of `answerKey`/`hints`, and latest-version selection.
- Dry-run on one lesson produces drafts with no writes.
- Studio publish stays disabled until an item is approved with all checks.
- Audit ≥20 generated candidates (or all, if fewer) before publishing any.
  Every published pilot item is individually approved.

## Checks

Web (Node 22): `npm run typecheck`, `npm run lint`, `npm test`, `npm run typegen`,
`npm run build`. Studio: `npm --prefix studio run typecheck`,
`npm --prefix studio run schema:validate`.

## Manual tests

1. `npm run generate:assessments -- --lesson <slug> --dry-run --out /tmp/asm.json`:
   the summary lists spans, candidates, and skip reasons. The file holds draft docs, and
   the dataset is unchanged.
2. Deploy the Studio (`npm --prefix studio run deploy` and `schema:deploy`,
   with your go-ahead). Run the same command without `--dry-run`, then check that the Studio →
   Assessments → Needs review list shows the drafts with a source excerpt.
3. Open a draft: Publish is disabled. Set `approved` with one check unticked, and
   validation errors. Tick all checks and Publish becomes enabled. Publish it.
4. Rerun step 2's command: 0 model calls, and every section is skipped (including sections with no candidates). Only failed sections are retried.
5. Approved item: content fields are read-only, and only the status fields are editable.
6. Context MCP probe: `*[_type == "assessment"][0...1]` returns `[]`.
   Search for a term that appears in a question still returns only lessons and videos.

## Rollback

Stop running the generator. Set affected items `archived` (then republish) to
hide them. Nothing is deleted. The schema is additive, and structure/action changes
revert by commit. Search, lessons, and progress are untouched.

## Outcome at commit (2026-09-12)

Follow-up work before commit is recorded in `prompts/pr-1-precommit-verification.md`, `prompts/pr-1-quality-followup.md`, and `prompts/pr-1-structured-explanations.md`. Detailed results are in `prompts/pr-1-candidate-audit.md`.

- **Run 3 (prompt v3), full pilot-course dry run:** 130 candidates, **117 accepted** (recall 53, apply 55, transfer 9) and 13 rejected with recorded reasons. 71 model calls, 0 model or network failures. Nothing was written to Sanity.
- **Transfer coverage:** **9 of 12 lessons produced an accepted transfer item.** The other 3 produced recorded `all_rejected` outcomes:
  - `csrf` and `mfa-and-oauth`: an option exceeded the 200-character limit;
  - `dependency-and-supply-chain`: generator wording "the lesson".

  No lesson is silently missing a transfer attempt.
- **Explanation integrity:**
  - 0 cut-off or corrupted explanations (Run 2 had 36 of 102, caused by strict-mode `maxLength` decoding);
  - every accepted item has a correct reason plus one reason per distractor, keyed by option id.
- **Answer position:** 30 / 28 / 30 / 29 across positions 1–4. The correct option is the longest in 40% of items, and none is 1.4× or more longer than the rest.
- **Learner privacy:** 0 leaks of the answer key, reasons, hints, source text, or review/generation metadata. This was checked through the real learner query over every accepted item, and again in the Studio smoke test.
- **Automated acceptance does not replace human review.** The generator's checks are lexical pre-filters. Every item still needs an editor to tick all six review checks, and the Studio publish gate enforces this.
- **Known limitations** (28-item manual sample, plus automated counts):
  - ambiguous or debatable options in 4 of 28: a distractor that is also defensible, a scenario that depends on a name from the video, or overstated wording;
  - hint-2 paraphrase leaks: 2 clear and 2 borderline of 28. Synonym paraphrases pass the heuristic;
  - soft source references ("as described here", "the workflow described"): 5 of 28;
  - level-3 solutions that only repeat the correct option's text: 20 of 117.
