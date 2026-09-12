# PR-1 quality follow-up

## Goal

Fix the generator quality defects that the pilot dry-run audit (`prompts/pr-1-candidate-audit.md`) found before PR-1 is committed:

- the answer's option position;
- generator language that learners can see;
- answer-length cues;
- missing transfer items;
- a dead-end Studio "create" path;
- `--force` creating duplicate drafts.

Then repeat the dry-run audit and run every check.

No deploy, no production assessment writes, no commit, no push, and none of the pre-existing `app/` or `components/` changes.

## Guidance read

- `AGENTS.md` §2, §3 (destructive operations count as high risk), and §10 (critical rules go in the inline prompt).
- Development plan §5 PR-1, line 173 (content contract) and line 178: "Use recall/apply/transfer as coverage targets, not fixed quotas per chunk."
- `prompts/pr-1-reviewed-assessments.md`, `prompts/pr-1-precommit-verification.md`, and `prompts/pr-1-candidate-audit.md`.

## Code and data inspected

- `lib/assessments/{generate,pipeline}.ts` and their tests.
- `scripts/generate-assessments.mts`.
- `studio/{sanity.config,structure}.ts` and `studio/schemaTypes/documents/{assessment,assessment-generation-record}.ts`.
- The previous dry-run output (105 accepted candidates, prompt v1) in the session scratchpad. The measurements below come from it.

## Findings that shape the plan

1. **Using the model's order is the position cue.** `mapCandidate` stores options in the order the model returned them. The model put the answer first in 92 of 105 candidates. Option `_key`s hash the model's index, and learners see `_key` as the option `id`.
2. **Positional references would become false after a shuffle.** In 51 of 105 candidates, the explanation (37) or solution (36) says things like "option 1 is correct" or "option 3 is wrong". Shuffling would make that text wrong, so it must be banned and rejected before any shuffle ships.
3. **Generator vocabulary is everywhere.** Items containing a banned word, by field (explanations and solutions are shown to learners after they answer):

   | Field | Items |
   | --- | --- |
   | Explanation | 103 / 105 |
   | Solution | 57 / 105 |
   | Question | 36 / 105 |
   | Direction hint | 10 / 105 |

   The model copies the prompt's own words: the system prompt and the Zod `.describe()` strings call the input a "span" ("grounded in the span").
4. **Length cue.** The correct option is the longest option in 62 of 105 candidates. Its length divided by the longest distractor's length:

   | Length ratio | Candidates |
   | --- | --- |
   | Under 0.8 | 18 |
   | 0.8–1.0 | 25 |
   | 1.0–1.2 | 29 |
   | 1.2–1.4 | 17 |
   | 1.4–1.6 | 9 |
   | 1.6 or more | 7 |

   Rejecting at 1.4× or more with a gap of at least 15 characters would reject 16 of 105. At 1.25× it would be 28; at 1.5×, 10.
5. **Why there are no transfer items (0 of 105).** The v1 system prompt contradicts itself:
   - `generate.ts:68` defines transfer as "use it in a context the span did not show";
   - `generate.ts:67` requires every question to be "answerable from the cited chunks alone";
   - line 68 ends "never force a type".

   The model resolves the conflict by never writing transfer.
6. **`--force` duplicates today.** Under `force`, `planSpanGeneration` returns `latest + 1`, and a test asserts this. A forced rerun therefore adds `…-v2` drafts next to the unreviewed `…-v1` drafts of the same families.
7. **The Studio has a dead end.** You can pick "Assessment" from the create menu, but the result can never be published: `sourceChunkRefs` is required, has a minimum of 1, and is read-only. "Duplicate" is worse: it copies the source refs and the family id, producing a publishable document outside the id scheme.

## Decisions

### 1. Deterministic seeded shuffle (in `mapCandidate`, after validation)

- A new `seededShuffle(items, seed)` does a Fisher–Yates shuffle. Swap index `j` comes from `sha256(seed, i)` (uint32 modulo `i+1`; the bias is negligible).
- The seed is `hashParts([documentId, inputHash])`. The same assessment and version always gets the same order; a new version gets a new one.
- Option `_key` is derived from the option's text (`opt-<hash(inputHash, normalized text)>`), so it no longer depends on the model's position.
- **No answer index is stored or served.** The answer key is `answerKey.correctOptionId`, an option id. The model's `correctOptionIndex` is mapped through the shuffle to the correct option's new position, and that option's id becomes the key.
- Tests:
  - the same input gives an identical order;
  - `options[newIndex]` is the original correct text, and `correctOptionId` points to it;
  - over 1,200 synthetic ids with the model index fixed at 0, every position gets 25% ± 5 points (4 options) and 33% ± 5 points (3 options).

### 2. Prompt v2 plus deterministic language rejection

- `ASSESSMENT_PROMPT_VERSION = 'assessment-generation-v2'`.
- The system prompt and the `.describe()` strings stop naming the input with any banned word ("span", "transcript" and so on). New rules:
  - write as if teaching the concept directly, and never refer to where the information came from;
  - refer to options only by their content, never by number, letter or position.
- New rejection code `generator_language`. It applies to all learner-visible text: question, options, explanation, and hints 1–3.
  - Case-insensitive, whole-word patterns (plurals included) from your list: `span`, `passage`, `speaker`, `transcript`, `section`, and `according to the text`.
  - Additions I'm proposing: `excerpt`, `chunk`, `presenter`, `narrator`; `according to the (span|passage|lesson|video|speaker|transcript|section|excerpt|source)`; and `(this|the) (video|lesson|clip)`.
- New rejection code `positional_reference`. It covers `option/answer/choice` followed by `1–4` or `A–D`, and "the first/second/third/fourth/last option|answer|choice", in any learner-visible field.
- Tests: every banned word in every field is rejected. These are **not** rejected: `sessions`, `subsection`, `expanse`, `C2 server`, and "The Content-Security-Policy header…".
  - Known cost: a legitimate phrase such as "the CSP header section" **is** rejected, because `section` is on your list. The test states this.

### 3. Option-length guard

- New rejection code `answer_length_cue`. It applies when the correct option is the uniquely longest **and** is at least 1.4× the longest distractor **and** at least 15 characters longer.
- Lengths do not have to match exactly. On v1 data this rejects 16 of 105.
- The v2 prompt asks for distractors with the same level of detail as the correct option.
- Tests cover a ratio just under and just over the threshold, the gap floor for short options, and ties.
- No "shortest option" rule: that cue did not show up in the data.

### 4. Transfer coverage (one lesson-level transfer call)

- **Section calls** return only `recall | apply` (the schema enum is narrowed). When a section supports two items, the prompt asks for one of each. There is no quota: a section may still return 0–2 items.
- **One transfer call per lesson**, as a coverage target per lesson (plan line 178):
  - The call sees exactly **one** bounded section, at most 12 chunks, never the transcript.
  - The section is chosen deterministically from the source: the section with the most chunks; ties go to the one nearest the middle of the lesson (ends tend to be intro or wrap-up).
  - The prompt defines transfer as a new scenario the chunks did not show, whose answer follows from a principle the cited chunks state. The cited chunks support the principle.
  - The transfer schema allows at most 1 item, with `type: 'transfer'`.
- **Record.** The existing `assessmentGenerationRecord` gains `kind: 'section' | 'lesson_transfer'`.
  - The transfer record's key is `hash(lesson, video, chosen chunk ids@revisions, prompt version, model, config version, 'lesson-transfer')`.
  - Outcomes are `drafted`, `no_candidates` or `all_rejected`; failures stay unrecorded and are retried.
  - Reruns skip it. A source change that moves or changes the chosen section generates it again.
- Transfer family id: `asm-<sha8(lesson)>-t-q0`, using the same versioning and replace rules as decision 6.
- `GENERATOR_CONFIG_VERSION` becomes `'spans-12-items-2-transfer-1-v2'`. All span keys change; production has 0 records, so nothing is orphaned.
- **Cost:** one extra call per lesson. The pilot course needs about 56 + 12 = 68 calls, within the 100-call cap.
- Tests, per lesson:
  - transfer drafted → one `lesson_transfer` record with outcome `drafted`, and a draft of type transfer;
  - the model returns nothing → the record's outcome is `no_candidates`, with no draft;
  - a rejected candidate → `all_rejected`;
  - a rerun makes 0 transfer calls;
  - a provider failure → no record, and retried on the next run;
  - a lesson with no chunks makes no call;
  - over a multi-lesson run, **every lesson with chunks ends with a transfer draft or an explicit `lesson_transfer` record**.

### 5. Studio: remove the dead end

- The generator is the only way to create assessments; there is no manual authoring path. A manual path would need its own grounding model, which PR-1 does not have.
- Changes:
  - `newDocumentOptions` filters out `assessment`;
  - every assessment list in `structure.ts`, including "All assessments", uses `.initialValueTemplates([])`;
  - the `duplicate` action is removed for `assessment`.
- The schema description says "Created only by `npm run generate:assessments`."
- Editing, review, publish and archive are unchanged.

### 6. `--force` replaces instead of duplicating

- For each family, the target version is the family's latest version **when that version exists only as an unpublished draft**; that draft is replaced in place with `createOrReplace` on the same id.
- Otherwise (the latest version is published, or there is no version) the target is `latest + 1`.
- Published versions, and therefore approved ones, are never touched. The immutability invariant is unchanged.
- The same rule applies when a changed source regenerates a section, so no family ever has two unreviewed drafts.
- The stale-marking patch still runs first in the same run, so a replaced draft ends up `current`.
- **Destructive step:** under `--force`, unpublished drafts of the same section that the new output does not reproduce are **deleted**. Deletion happens in that section's transaction, and only for drafts with no published version. Any review work saved on those unpublished drafts is lost; that is what `--force` means.
  - The alternative is to keep them and list them in the report. That leaves orphaned drafts, but deletes nothing.
- Tests (the existing "force gives the next version" test is inverted):
  - a forced rerun over unpublished drafts emits `createOrReplace` on the same ids, with no new version;
  - over a published v1 it creates v2 and leaves v1 untouched;
  - when the rerun has fewer items, the extra unpublished draft is deleted;
  - the transfer family follows the same rules.

### 7. Distributions and the repeat audit

- A new pure function `summarizeCandidates(drafts, records)` in `lib/assessments/quality.ts`. It returns:
  - counts by type;
  - the correct-answer position histogram, by option count;
  - the length-ratio buckets and the rank of the correct option's length;
  - rejection reasons by code;
  - section and transfer outcomes.
- The CLI prints the summary at the end of every run. It is tested.
- Rerun the dry run over the whole pilot course: `npm run generate:assessments -- --course practical-web-security --dry-run --out <scratchpad>/course-dry-run-v2.json`. It is read-only against `production` (about 68 calls, run in the background).
  - If a lesson fails on a temporary fetch error, rerun only that lesson (`--lesson`). No retry logic is added.
- Rerun the exposure check (learner query over every candidate treated as approved) and a stratified manual review of at least 20 candidates, including every transfer item.
- Append the results as "Run 2 (prompt v2)" to `prompts/pr-1-candidate-audit.md`, still labelled a preliminary AI review.

### 8. Studio verification (requires your choice)

Recommended: the same headless check you approved last round, on a throwaway dataset. It confirms:

- the create menu has no Assessment;
- the assessment lists offer no create button;
- the document menu has no Duplicate;
- review and publish still work.

The throwaway dataset is created, then deleted. The Studio runs on port 3334, and your 3333 Studio is not touched.

Alternative: you check it manually.

## Expected files

- **New:**
  - `lib/assessments/quality.ts` (shuffle, language, positional and length checks, summary);
  - `lib/assessments/quality.test.ts`;
  - `prompts/pr-1-quality-followup.md` (this file).
- **Modified:**
  - `lib/assessments/generate.ts`: prompt v2, transfer prompt and schema, shuffle, the new rejection codes, the version rule;
  - `lib/assessments/generate.test.ts`;
  - `lib/assessments/pipeline.ts`: the transfer pass, the `kind` field, `createOrReplace`/`delete` mutations;
  - `lib/assessments/pipeline.test.ts`;
  - `scripts/generate-assessments.mts`: fetch `type` and published state, print the summary;
  - `studio/sanity.config.ts`, `studio/structure.ts`;
  - `studio/schemaTypes/documents/assessment.ts` (description only);
  - `studio/schemaTypes/documents/assessment-generation-record.ts` (`kind`);
  - `sanity.types.ts` (TypeGen);
  - `docs/DATA_MODEL.md` (§15);
  - `prompts/pr-1-reviewed-assessments.md` (decisions about force and types);
  - `prompts/pr-1-candidate-audit.md` (Run 2).
- **Untouched:** all pre-existing `app/` and `components/` changes.

## Security

- No new secrets or routes.
- The learner query is unchanged. Option ids are now derived from content, not model position.
- The transfer call remains one bounded section of at most 12 chunks.
- The only deletion covers unpublished generator drafts under `--force`.

## Acceptance criteria

- The shuffle is deterministic per id, and position is uniform within ±5 points over 1,200 ids.
- Explanations and solutions never reference options by position (rejected).
- Banned wording is rejected in every learner-visible field, and the false-positive tests pass.
- The length guard rejects items at or over the threshold and accepts items under it.
- Every lesson with chunks ends with a transfer draft or an explicit `lesson_transfer` record.
- `--force` produces no duplicate family versions.
- The create menu and lists offer no Assessment, and Duplicate is gone.
- The Run 2 audit reports:
  - counts by type;
  - the position distribution;
  - the number of language rejections;
  - the length distribution;
  - acceptance and rejection reasons.

## Checks

Node 22:

- `npm test`
- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `npm run typegen`
- `npm --prefix studio run typecheck`
- `npm --prefix studio run schema:validate`

## Rollback

- Everything is uncommitted.
- The dry run writes nothing.
- The throwaway dataset is deleted.
- Production stays at 0 assessments and 0 records.
