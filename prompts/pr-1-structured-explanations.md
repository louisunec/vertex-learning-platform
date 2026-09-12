# PR-1: structured explanations and truncation fix

## Goal

Stop generated text from being cut off, and stop cut-off text from ever being stored. Explanations move to structured, per-option reasons. The generator also gets deterministic rejection rules for text that points at a source learners cannot see. Then a two-lesson canary dry run, and a full pilot rerun only if the canary passes.

No deploy, no production writes, no commit, no push, and none of the pre-existing `app/` or `components/` changes.

## Guidance read

- `AGENTS.md` §2, §3 and §10.
- `prompts/pr-1-quality-followup.md` and `prompts/pr-1-candidate-audit.md` (Run 2).
- Installed `@ai-sdk/openai` 4.0.62 (`dist/index.js`, Responses API request builder) and `ai` 7.0.94 `Output.object`.

## Exact cause of the 800-character cutoff (item 1)

**Provider-side constrained decoding during generation.** It is not schema validation, sanitization, or string slicing.

1. `generate.ts` declares `explanation: z.string().trim().min(1).max(800)`. Zod 4 converts that to JSON Schema `{"type":"string","minLength":1,"maxLength":800}`.
2. `@ai-sdk/openai` sends the schema as `text.format: {type: "json_schema", strict: strictJsonSchema}`, and `strictJsonSchema` defaults to `true` (`dist/index.js:6997` and `:7041`).
3. In strict mode, OpenAI constrains decoding to the schema, including `maxLength`: the string is closed at the limit wherever the text happens to be. The stray CJK tails (`誰`, `短`, `쿼리语`) are the tokens the model was still allowed to emit as the remaining length ran out.
4. Zod's `.max(800)` then **passes**, because the string is exactly 800 characters.

Evidence:

- All 36 cut explanations are exactly 800 characters (one is 799 after trimming).
- Our code never slices explanations. The only generated-text `.slice` is `modelSkipReason` (`pipeline.ts:268`).
- A diagnostic call asked for about 300 characters under a `maxLength: 60` schema:
  - with `strict: true` it returned exactly 60 characters, ending mid-sentence ("…from data by sending");
  - with `strict: false` the model wrote the full text, and Zod rejected the output (`NoObjectGeneratedError`).

## Decisions

### 1. No length limits in the schema sent to the provider (items 2 and 5)

- The model output schema keeps its structure (required fields, enums, array bounds) and strict mode, but **no string `maxLength`**.
- The limits move into a `FIELD_LIMITS` table enforced in `mapCandidate`.
- An over-limit field rejects the candidate with `field_too_long:<field>`. It is never truncated and never stored.
- **No repair call**: rejection is deterministic, costs nothing, and the rejected item is recorded. The alternative is at most one bounded "shorten this field" re-ask per candidate.
- Limits:

  | Field | Limit |
  | --- | --- |
  | objective | 200 |
  | question | 400 |
  | option text | 200 |
  | correct reason | 300 |
  | distractor reason | 200 |
  | hint 1 (direction) | 500 |
  | hint 2 (key concept) | 500 |
  | hint 3 (solution) | 800 |

  The limits are stated in each field's `.describe()` text, so the model knows them.
- A regression test asserts that the generated provider JSON Schema contains no `maxLength` anywhere.
- `modelSkipReason` is an operator-only log field. It keeps its 200-character cap, but anything shortened ends in a visible "…" instead of being silently cut.

### 2. Structured explanations (items 3 and 4)

- The model writes each option as `{text, correct, reason}`. The reason sits on the option it explains, so the model never refers to another option at all.
- `correctOptionIndex` and `explanation` are removed from the model output.
- The mapper rejects `correct_option_count` unless exactly one option has `correct: true`. This replaces `correct_option_out_of_range`.
- After the seeded shuffle, the server stores:
  - `answerKey.correctOptionId` (the stable option `_key`);
  - `answerKey.correctReason` (max 300);
  - `answerKey.distractorReasons: [{_key, optionId, reason}]`: one entry per distractor, keyed by the stable option id (max 200 each).
- No position is stored anywhere.
- New rejection `reason_repeats_option`: a reason that contains the full normalized text of any option with 3 or more words. Short names such as `useState` or `package.json` may still be mentioned. The level-3 solution may still name the answer.
- The existing positional-reference rule now covers the reasons.
- Studio `answerKey` (private, never projected):
  - `explanation` is replaced by `correctReason` and `distractorReasons`;
  - validation: the set of `optionId`s must equal the option ids minus the correct one.
- Production has 0 assessments, so nothing needs migrating.

### 3. Truncation and corruption guards (items 2 and 7)

These apply even though decision 1 removes the root cause.

- `truncated_text`: a question, reason or hint does not end with sentence punctuation (`. ? ! : ) " ' ” ’`). Options are phrases and are exempt. On the 102 v2 items this flagged 0 questions and 0 hints; it would have caught all 36 cut explanations.
- `corrupted_text`: a mostly Latin-script field contains any Han, Kana or Hangul character. Text that is mainly in a CJK script is not flagged, so a lesson written in Chinese still works.

### 4. Hidden-source wording (item 6)

All learner-visible text is checked: question, options, both reason fields, hints 1–3. Rejection reasons carry the matched term (e.g. `generator_language:section`), so the audit can count false positives. That was missing in Run 2.

- `generator_language`: the existing list, plus `instructor(s)`, `demo(s)`, `demonstration(s)` and `the demonstrated`.
- `source_pointer`: "sentence/lines in the source" phrasing. Patterns:
  - "the/this/that/these/those sentence(s)/line(s)/part(s)/portion(s)/segment(s)/remark(s)/discussion/description/warning/analogy/walkthrough" followed by "that / which / where / about / describing / explaining / mentioning / discussing / comparing / contrasting / listing / naming / defining / showing / on";
  - "look at / look for / look in / find / check / re-read / refer to / review / revisit" followed within 3 words by "sentence(s) / statement(s) / remark(s) / discussion / description / analogy / walkthrough / recommendation / guidance / warning".

  Counted with `findSourcePointer` (`lib/assessments/quality.ts`) over the 102 Run 2 (v2) items: 66/102 match, all in hint 1, the same count as the Run 2 audit (`prompts/pr-1-candidate-audit.md`). An earlier version of this note said 72/102; that count does not reproduce with the committed detector. Every sampled hit was a true pointer. Not flagged: "the first two lines of the config file", "the example request below".
- `chunk_label`: lowercase `c` plus 1–2 digits as a standalone token (`c0`, `c1`, `c0–c1`, `(c3)`). Uppercase `C2 server` is not flagged.
- The prompt changes too, because v1 invited pointing:
  - hint 1 becomes "a nudge about which consideration or concept matters, written for a learner who has never seen any source";
  - an explicit rule: never tell the learner to find, look at, or re-read anything;
  - never use chunk labels outside `sourceChunks`.

### 5. Versioning

- `ASSESSMENT_PROMPT_VERSION = 'assessment-generation-v3'`. All keys change, which is harmless because production has 0 records.
- `GENERATOR_CONFIG_VERSION` is unchanged.

### 6. Canary, then full run (items 8 and 9)

- **Canary:** two dry runs in parallel, read-only:
  - `--lesson practical-web-security-password-storage` (7 sections; C62's wrong transfer came from here);
  - `--lesson practical-web-security-https-headers-and-csp` (7 sections; chunk labels and length rejections).

  That is about 16 calls and 25–30 candidates. I audit about 20, including both transfer items.
- **The canary passes only if all of these hold:**
  - accepted items contain 0 truncated text, 0 corrupted text, 0 generator or source-pointer wording, 0 chunk labels and 0 positional references;
  - every accepted item has one correct reason plus one reason per distractor, mapped by id, with no full option text repeated;
  - recall, apply and transfer each appear at least once;
  - at least 60% of candidates are accepted;
  - the manual audit finds at most 1 wrong or ambiguous answer.
- **If it fails:** stop and report. No full run.
- **If it passes:** rerun the full pilot-course dry run (about 71 calls, about 50 minutes), then append "Run 3 (prompt v3)" to `prompts/pr-1-candidate-audit.md`. It will include the canary table, counts by type, position and length distributions, rejection reasons with matched terms, and a stratified sample of 20 or more items.

## Tests (item 7)

- **Mid-word truncation:** a reason or hint ending "…the query's struc" is rejected as `truncated_text`.
- **CJK tail:** an English reason ending "…must first confirm誰" is rejected as `corrupted_text`. A Chinese-language reason is accepted.
- **After the shuffle:** across 1,200 seeds:
  - `correctReason` comes from the option marked correct;
  - each `distractorReasons[].optionId` points to the option whose reason it carries;
  - every distractor has exactly one reason;
  - no reason contains a positional reference.
- **Oversized output:**
  - each field one character over its limit is rejected as `field_too_long:<field>`, and no draft is produced;
  - the provider JSON Schema has no `maxLength`;
  - an exactly-at-limit field that ends in punctuation is accepted.
- **Hidden-source wording and chunk labels:** positive and false-positive sets for `generator_language`, `source_pointer` and `chunk_label`.
- **Structure:** zero or two correct options are rejected as `correct_option_count`; a reason that repeats an option's full text is rejected as `reason_repeats_option`.
- **Learner exposure:** the learner-query test's forbidden list adds `correctReason` and `distractorReasons`.
- Existing pipeline, transfer and `--force` tests are updated to the new item shape.

## Expected files

- **New:** `prompts/pr-1-structured-explanations.md` (this file).
- **Modified:**
  - `lib/assessments/{generate,quality,pipeline}.ts`;
  - tests: `generate.test.ts`, `quality.test.ts`, `pipeline.test.ts`, `learner-query.test.ts`;
  - `studio/schemaTypes/documents/assessment.ts` (`answerKey`);
  - `sanity.types.ts` (TypeGen);
  - `docs/DATA_MODEL.md` §15;
  - `prompts/pr-1-reviewed-assessments.md` (decision 10's answer-key shape);
  - `prompts/pr-1-candidate-audit.md` (canary, and Run 3 if it passes).
- **Untouched:** the pre-existing `app/` and `components/` changes.

## Security

- The learner projection is unchanged: `answerKey` is never selected, and the new fields sit inside it.
- No new secrets or routes.
- One model call per section and one transfer call per lesson, as before, and still one bounded span per call.

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
- The dry runs write nothing.
- Production stays at 0 assessments and 0 records.
