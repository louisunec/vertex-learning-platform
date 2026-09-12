# PR-1 candidate audit: pilot course dry run

**Status: preliminary AI review.** This is not the competent subject-matter review that the development plan's learning gate requires (§6). Nothing was written to Sanity.

## Run

- Command: `npm run generate:assessments -- --course practical-web-security --dry-run --out <scratchpad>/course-dry-run.json`, run with the post-verification generator (prompt `assessment-generation-v1`, `gpt-5-mini`, reasoning effort medium), 2026-09-12.
- Scope: 12 lessons. 11 were processed. `practical-web-security-sessions-vs-jwt` failed on a transient Sanity `fetch failed` and will be retried on the next run.
- 56 sections across the 11 processed lessons, one model call each: 55 returned a schema-valid response, and 1 timed out. The timeout produced no record, so it is retried on the next run.

## Generator outcome (all candidates)

| Measure | Result |
| --- | --- |
| Candidates returned by the model | 108 |
| Accepted drafts | **105** |
| Rejected | **3**: `hint_leak` ×2 (one whole section, `cross-site-scripting` #3), `duplicate_options` ×1 |
| Section outcomes | 54 `drafted`, 1 `all_rejected`, 0 `no_candidates` |
| Types | 70 recall, 35 apply, **0 transfer** |
| Learner exposure: all 105 treated as approved and run through the real learner query and parser | 105 rows, **0 leaks** of answer key, correct option id, hints, explanation, source text, review or generation metadata |

## Systemic defects (all 105, automated)

| Defect | Count | Effect |
| --- | --- | --- |
| Correct answer is option 1 | **92 / 105 (88%)**; positions 1–4 are 92 / 9 / 3 / 1 | A learner can guess "first option" without knowing anything. **Blocking before any publish.** |
| Correct option is the uniquely longest | 60 / 105 (57%) | Length cue. |
| Internal/meta wording in learner-visible text ("span", "passage", "speaker", "presenter", "the lesson") | 40 / 105 (37 in the question stem; "span" ×20) | Internal jargon that learners see. This breaks the prompt rule. |
| Correct option repeats question wording (≥50% of its content words, ≥0.2 more than any distractor) | 4 / 105 | The question wording reveals the answer. |

## Stratified manual review (27 items: every 4th candidate, covering all 11 processed lessons)

| # | Lesson | Answer correct | Grounded in cited chunks | Hint leak (1–2) | Wording reveals answer | Other |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | OWASP top ten | ✓ | ✓ | no | no | trivia recall |
| C5 | OWASP top ten | ✓ | ✓ | no | no | stem says "the lesson" |
| C9 | OWASP top ten | ✓ | ✓ | no | no | stem says "the span"; length cue |
| C13 | AuthN vs AuthZ | ✓ | ✓ | no | no | length cue |
| C17 | Secure defaults | ✓ | ✓ | no | no | weak distractors |
| C21 | Secure defaults | ✓ | ✓ | **borderline**: H2 "quickly render exposed secrets unusable" points at the answer via synonyms (not caught by the heuristic) | **yes**: only the correct option repeats "after each use" from the stem | |
| C25 | XSS | ✓ | ✓ | no | no | |
| C29 | XSS | ✓ | ✓ | no | no | length cue |
| C33 | XSS | ✓ | ✓ | no | no | good item |
| C37 | SQL injection | ✓ | ✓ (one sentence) | no | no | "according to the span"; length cue |
| C41 | CSRF | ✓ | ✓ | no | no | good apply item |
| C45 | CSRF | ✓ | ✓ | no | no | "according to the passage" |
| C49 | Password storage | ✓ | ✓ | no | no | weak distractors |
| C53 | Password storage | ✓ | ✓ | no | no | good item |
| C57 | Password storage | ✓ | ✓ | no | no | one absurd distractor |
| C61 | MFA and OAuth | ✓ | ✓ | no | no | good item |
| C65 | HTTPS headers and CSP | ✓ | ✓ | no | no | "as explained in the span"; answer copies the source verbatim; length cue |
| C69 | HTTPS headers and CSP | ✓ | ✓ | no | no | length cue |
| C73 | HTTPS headers and CSP | ✓ | ✓ | no | no | good apply item |
| C77 | HTTPS headers and CSP | ✓ | ✓ | no | no | length cue |
| C81 | Secrets management | ✓ | ✓ | no | no | H1 says "the speaker" |
| C85 | Secrets management | ✓ | ✓ | no | no | stem says "the presenter" |
| C89 | Secrets management | ✓ | ✓ | no | no | absurd distractors |
| C93 | Supply chain | ✓ | ✓ | no | no | good item |
| C97 | Supply chain | ✓ | ✓ | no | no | good item |
| C101 | Supply chain | ✓ | ✓ | no | no | absurd distractors; length cue |
| C105 | Supply chain | ✓ | ✓ | no | **yes**: the stem paraphrases the "autofix" definition | |

Sample totals:

- answer correct 27/27;
- grounded 27/27;
- clear hint leaks 0/27, borderline 1/27;
- wording reveals answer 2/27;
- meta wording 7/27;
- length cue 8/27;
- weak or absurd distractors 5/27.

## Recommended before any real run or publish (not implemented; needs approval)

1. **Deterministic option shuffle** in `mapCandidate`, seeded by `generation.inputHash`, so the stored order carries no position cue. PR-7 can shuffle again at delivery and record the delivered order.
2. **Prompt additions:** never use "span", "passage", "speaker", "presenter" or "the lesson" in the question, options or hints; keep distractors the same length as the correct option; never repeat the stem's distinctive words only in the correct option. Bump `ASSESSMENT_PROMPT_VERSION` to v2. Existing records then no longer match, so affected sections regenerate.
3. **Generator checks:** reject meta wording in learner-visible text; flag (not reject) length and stem-overlap cues for reviewers.
4. Consider asking for `transfer` items explicitly (0 of 105 so far).

---

# Run 2 (prompt v2, quality follow-up)

**Status: preliminary AI review**, not the subject-matter review the plan requires. Nothing was written to Sanity. The implementation is described in `prompts/pr-1-quality-followup.md`.

## Run

- Command: `npm run generate:assessments -- --course practical-web-security --dry-run --out <scratchpad>/course-dry-run-v2.json`, run on 2026-09-12 with `assessment-generation-v2`, config `spans-12-items-2-transfer-1-v2`, `gpt-5-mini`, medium reasoning effort.
- Scope: all 12 lessons processed, including `sessions-vs-jwt`. 71 model calls (59 section calls and 12 lesson-transfer calls), 0 failures.

## Generator outcome (item 7 of the follow-up request)

| Measure | Run 1 (v1) | Run 2 (v2) |
| --- | --- | --- |
| Candidates returned | 108 | **130** |
| Accepted / rejected | 105 / 3 | **102 / 28** |
| Rejection reasons | hint_leak 2, duplicate_options 1 | **generator_language 24**, answer_length_cue 3, hint_leak 1 |
| Recall / apply / transfer | 70 / 35 / **0** | **47 / 44 / 11** |
| Section outcomes | 54 drafted, 1 all_rejected | 54 drafted, 5 all_rejected, 0 no_candidates |
| Lesson transfer outcomes | none | **11 drafted, 1 all_rejected** (`mfa-and-oauth`: answer_length_cue), 0 no_candidates. All 12 lessons have a transfer draft or an explicit record. |
| Correct position #1 / #2 / #3 / #4 (all 4 options) | 92 / 9 / 3 / 1 | **19 / 35 / 22 / 26** (consistent with uniform: χ² ≈ 5.7, 3 df) |
| Correct length ÷ longest distractor: <0.8 / 0.8–1.0 / 1.0–1.2 / 1.2–1.4 / ≥1.4 | 18 / 25 / 29 / 17 / 16 | **19 / 30 / 37 / 16 / 0** |
| Correct option is the longest | 60 / 105 (57%) | 51 / 102 (50%) |
| Generator vocabulary in accepted items (banned list) | 103 / 105 | **0** |
| Positional option references in accepted items | 51 / 105 | **0** |
| Learner exposure (all accepted items treated as approved, real query and parser) | 0 leaks | **0 key or field leaks.** 11 substring hits are level-3 solutions that equal the correct option's text word for word. Option text is public by design, and the hit does not show which option is correct. |

`generator_language` rejections do not record which word matched, so this run cannot say how many were caused by the accepted `section` false-positive cost.

## Defect introduced by v2 (blocks a real run)

| Measure | Run 1 | Run 2 |
| --- | --- | --- |
| Explanations that stop at the 800-character `maxLength` without end punctuation | 4 / 105 | **36 / 102** (all at exactly 800) |
| Of those, ending in stray CJK tokens | 0 | 6 |
| Transfer explanations affected | none | **11 / 11** |
| Median explanation length | 542 | 748 |

Cause: the v2 rule "refer to options by content" makes explanations restate all four options in full. The provider enforces the schema's `maxLength` during generation, so the text is cut mid-word. Solutions (median 162 characters) are unaffected.

## Stratified manual review (36 items: every 4th candidate plus all 11 transfer items, covering all 12 lessons)

| # | Lesson | Type | Correct shown at | Answer correct | Grounded | Hint 1–2 leak | Wording reveals answer | Explanation cut off | Other |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C1 | OWASP | recall | #4 | ✓ | ✓ | no | no | | trivia |
| C5 | OWASP | apply | #4 | ✓ | ✓ | no | no | | "was recommended" |
| C9 | OWASP | recall | #4 | ✓ | ✓ | no | no | yes | "the example given"; length cue |
| C11 | OWASP | transfer | #2 | ✓ | ✓ | no | no | yes | good transfer (Node SQL concatenation) |
| C13 | AuthN/AuthZ | recall | #3 | ✓ | ✓ | no | no | | |
| C15 | AuthN/AuthZ | transfer | #3 | ✓ | ✓ | no | no | yes (CJK) | good transfer |
| C17 | Secure defaults | apply | #2 | ✓ | ✓ | no | no | yes | |
| C21 | Secure defaults | apply | #2 | ✓ | ✓ | no | no | yes (CJK) | |
| C22 | Secure defaults | transfer | #4 | ✓ | ✓ | **borderline** (H1 describes rotating after use) | no | yes (CJK) | |
| C25 | XSS | recall | #2 | ✓ | ✓ | no | no | yes | |
| C29 | XSS | apply | #2 | ✓ | ✓ | no | no | | good apply |
| C32 | XSS | transfer | #1 | ✓ | ✓ | no | no | yes | good transfer |
| C33 | SQL injection | recall | #3 | ✓ | ✓ | no | no | yes (CJK) | |
| C37 | SQL injection | transfer | #2 | ✓ | ✓ | no | no | yes | good transfer (DELETE endpoint) |
| C41 | CSRF | recall | #1 | ✓ | ✓ | no | no | | H1 "the instructor's early comment" |
| C44 | CSRF | transfer | #2 | ✓ | ✓ | no | no | yes | correct option much more specific |
| C45 | Sessions vs JWT | recall | #4 | ✓ | ✓ | no | no | | |
| C49 | Sessions vs JWT | recall | #3 | ✓ | ✓ | no | no | | |
| C50 | Sessions vs JWT | transfer | #4 | ✓ | ✓ | no | no | yes | good transfer |
| C53 | Password storage | apply | #3 | ✓ | ✓ | no | no | yes | |
| C57 | Password storage | apply | #4 | ✓ | ✓ | no | no | | |
| C61 | Password storage | apply | #2 | ✓ | ✓ | no | no | | |
| C62 | Password storage | transfer | #1 | **✗** | ✓ (principle) | no | no | yes (CJK) | **The marked answer is wrong.** It says to hash API keys that the service must later use to call third-party APIs, but a one-way hash cannot be used. Encryption with a separately managed key is the right practice. |
| C65 | MFA and OAuth | recall | #3 | ✓ | ✓ | no | no | | |
| C69 | HTTPS headers/CSP | recall | #1 | ✓ | ✓ | no | no | | |
| C73 | HTTPS headers/CSP | recall | #2 | ✓ | ✓ | no | no | | H1 quotes chunk labels "c0–c1" |
| C77 | HTTPS headers/CSP | apply | #1 | ✓ | ✓ | no | no | yes | |
| C79 | HTTPS headers/CSP | transfer | #2 | ✓ | ✓ | no | no | yes | good transfer (CORS allowlist) |
| C81 | Secrets management | apply | #4 | ✓ | ✓ | no | no | | Q "did the instructor explicitly warn" |
| C85 | Secrets management | recall | #2 | ✓ | ✓ | **borderline** (H2 separates the unlock value from the auth value) | no | | |
| C86 | Secrets management | transfer | #2 | ✓ (debatable) | ✓ | no | no | yes | "Following the demonstrated practice". The environment-variable distractor is also defensible for some providers. |
| C89 | Supply chain | recall | #3 | ✓ | ✓ | no | no | | |
| C93 | Supply chain | apply | #3 | ✓ | ✓ | no | no | | |
| C97 | Supply chain | apply | #4 | ✓ | ✓ | no | no | yes | |
| C101 | Supply chain | apply | #1 | ✓ | ✓ | no | **yes**: only the correct option repeats "breaking-change" from the stem | yes | |
| C102 | Supply chain | transfer | #2 | ✓ | ✓ | no | no | yes | good transfer (dev-only dependency) |

Sample totals:

- answer correct 35/36 (C62 wrong; C86 debatable);
- grounded 36/36;
- clear hint leaks 0/36, borderline 2/36;
- wording reveals the answer 1/36;
- explanation cut off 20/36, including 11/11 transfer items.

## Patterns across all 102 accepted items

- **Hint 1 points at source text learners cannot see** ("Find the sentence that…", "Look at the lines…"): 66/102. This predates v2 (73/105 in run 1). The v1 hint-ladder definition "direction: where to look" invites it.
- **Attribution synonyms outside the banned list** ("the instructor", "the demo", "demonstrated", "the example given"): 12/102.
- **Chunk labels** (`c0`, `c1`…) in learner-visible text: 6/102 (69/105 in run 1).
- **Level-3 solution is only the correct option's text**, with no explanation: 11/102.

---

# Run 3 (prompt v3: structured explanations)

**Status: preliminary AI review.** Nothing was written to Sanity. The implementation is described in `prompts/pr-1-structured-explanations.md`.

**Cause of the Run 2 cutoff, now fixed.** OpenAI strict structured output (on by default in `@ai-sdk/openai`) enforces JSON Schema `maxLength` while decoding. It closed each explanation at exactly 800 characters, and Zod's `.max(800)` then passed. A diagnostic call with a 60-character limit reproduced it: strict mode returned exactly 60 characters, cut mid-sentence. v3 sends no string `maxLength`, checks limits after generation, and rejects any over-limit, cut-off, or corrupted text instead of storing it.

## Canary (two lessons, run before the full course)

- Command: `--lesson practical-web-security-password-storage` and `--lesson practical-web-security-https-headers-and-csp`, both `--dry-run`, run on 2026-09-12. 16 model calls, 0 failures.

| Gate | Result |
| --- | --- |
| Candidates / accepted | 30 / **25 (83%)**. Rejected: answer_length_cue 3, generator_language:excerpt 1, hint_leak 1. |
| Types | recall 12, apply 11, transfer 2 (both lessons drafted a transfer item) |
| Accepted items with truncated text / corrupted text / generator language / source pointers / chunk labels / positional references | **0 / 0 / 0 / 0 / 0 / 0** |
| One correct reason plus one reason per distractor, mapped by option id | 25 / 25 |
| Reasons that repeat an option's full text | 0 |
| Reason length | correct: median 141, max 185 (limit 300); distractor: median 119, max 156 (limit 200) |
| Correct position #1 / #2 / #3 / #4 | 3 / 6 / 9 / 7 |
| Learner exposure (all 25 treated as approved) | 0 leaks |

Manual audit of all 25 canary items:

- answer correct 25/25;
- imprecise 1/25 (K21 says "same site" where the referrer policy means same origin);
- hint 2 paraphrases the answer: 1 clear (K13, HSTS) and 2 borderline (K16, K18). The lexical heuristic does not catch these; human review is the gate;
- soft attribution wording ("mentioned", "cited", "the problem described") in 2/25 (K1, K6), which is not covered by the rules;
- level-3 solution that is only the option text: 3/25;
- the correct option is the longest in 12/25.

Both transfer items are good:

- K12 works out bcrypt cost from measured time (125 ms at cost 12 → cost 14 for about 500 ms);
- K25 chooses CORS headers for a new app and API pair.

**Canary verdict: pass.** Every gate in the plan is met, so the full course was rerun.

## Full pilot course (Run 3)

- Command: `npm run generate:assessments -- --course practical-web-security --dry-run --out <scratchpad>/course-dry-run-v3.json`, run on 2026-09-12 with `assessment-generation-v3`.
- 12 lessons, 71 model calls (59 section calls and 12 transfer calls). 0 model failures, 0 Sanity fetch failures.

| Measure | Run 2 (v2) | Run 3 (v3) |
| --- | --- | --- |
| Candidates / accepted / rejected | 130 / 102 / 28 | 130 / **117 (90%)** / 13 |
| Rejection reasons | generator_language 24, answer_length_cue 3, hint_leak 1 | answer_length_cue 4; generator_language 4 (`transcript` 2, `sections` 1, `the lesson` 1); field_too_long 3 (`option0` 2, both transfer; `reason1` 1); hint_leak 2 |
| Recall / apply / transfer | 47 / 44 / 11 | 53 / 55 / 9 |
| Transfer outcome per lesson | 11 drafted, 1 all_rejected | 9 drafted, 3 all_rejected (`csrf` and `mfa-and-oauth`: an option over 200 characters; `dependency-and-supply-chain`: "the lesson"). All 12 lessons have a draft or an explicit record. |
| Explanations cut at the length limit | **36 / 102** (6 with CJK tails; all 11 transfer items) | **0 / 117** |
| Corrupted text | 6 | 0 |
| Correct reason + one reason per distractor, by option id | n/a (free-text explanation) | 117 / 117 |
| Reason length | explanation median 748 (limit 800) | correct: median 138, max 199 (limit 300); distractor: median 122, max 191 (limit 200) |
| Generator language / source pointers / chunk labels / positional references in accepted items | 0 / 66 hint-1 pointers / 6 / 0 | **0 / 0 / 0 / 0** |
| Correct position #1 / #2 / #3 / #4 | 19 / 35 / 22 / 26 (χ² ≈ 5.7) | **30 / 28 / 30 / 29** (χ² ≈ 0.1) |
| Correct length ÷ longest distractor: <0.8 / 0.8–1.0 / 1.0–1.2 / 1.2–1.4 / ≥1.4 | 19 / 30 / 37 / 16 / 0 | 25 / 44 / 32 / 16 / 0 |
| Correct option is the longest | 51 / 102 (50%) | 47 / 117 (40%) |
| Level-3 solution is only the option text | 11 / 102 | 20 / 117 |
| Soft attribution ("mentioned", "described", "shown"; not a rejection rule) | n/a | 20 / 117 by broad regex; 5 / 28 in the manual sample |
| Learner exposure (all accepted items treated as approved; real query and parser) | 0 key/field leaks | **0 leaks** across 117 rows, including `correctReason` and `distractorReasons` |

## Manual review (28 items: all 9 transfer items plus every 6th other item)

| # | Type | Lesson | Correct | Notes |
| --- | --- | --- | --- | --- |
| K12 | transfer | OWASP | ✓ | Search-term SQL concatenation → prepared statements. Good. |
| K16 | transfer | AuthN/AuthZ | ✓ | Smart-home thermostat → a server-side permission check. Good. |
| K23 | transfer | Secure defaults | ✓ | Nightly job → vault plus per-run credentials. Good. |
| K35 | transfer | XSS | ✓ | **Imprecise scenario**: a stored comment widget is framed as an attack "by sending a link" (reflected). Encoding output is right for both. |
| K40 | transfer | SQL injection | ✓ | Sort column → allowlist, because identifiers can't be bound. Very good. |
| K55 | transfer | Sessions vs JWT | ✓ | Mobile app → short-lived access token plus refresh token. |
| K70 | transfer | Password storage | ✓ | Tune the cost to server capacity. Good. |
| K88 | transfer | HTTPS headers/CSP | ✓ | Single-origin CORS with narrowed methods and headers. |
| K100 | transfer | Secrets management | ✓ | CI pipeline → fetch from a secrets manager at runtime. |
| K1, K7, K13, K19, K25, K37, K61, K67, K79, K85, K97, K103 | recall/apply | various | ✓ | K85: hint 2 gives the answer away (clear leak). K79: borderline. |
| K31 | apply | XSS | ✓ (ambiguous) | The "explicit exception for inline scripts" distractor is also true, and its own reason concedes it. |
| K43 | apply | CSRF | ✓ (debatable) | "Logged in as WDS" names a user from the source, which learners haven't seen. SameSite=Lax defaults in current browsers would block this POST. |
| K49 | recall | Sessions vs JWT | ✓ | "described as 'stateful'" (soft attribution) |
| K73 | recall | MFA/OAuth | ✓ | "as described here" (soft attribution). Hint 2 gives the answer away (clear leak). |
| K91 | apply | Secrets management | ✓ (ambiguous) | The environment-variable distractor also satisfies the question. Its reason says "the practice shown". |
| K109 | apply | Supply chain | ✓ | "the workflow described" (soft attribution). Hint 2 borderline. |
| K115 | apply | Supply chain | ✓ (debatable) | "Treat the finding as ignorable" overstates it; the reason says "deprioritize". |

Sample totals:

- answer wrong 0/28; ambiguous or debatable 4/28 (K31, K43, K91, K115);
- transfer correctness 9/9, with 1 imprecise scenario;
- soft or implicit source references 5/28;
- hint-2 leaks 2 clear, 2 borderline;
- explanation integrity 28/28.

## Final Studio smoke test (structured explanations, 2026-09-12)

Setup:

- a throwaway private dataset `pr1-smoke`, later deleted;
- a local Studio on port 3334, driven by headless Chrome;
- fixtures taken from real Run 3 generator output for `password-storage`:
  - an apply draft (needs review);
  - the transfer draft (approved, all six checks);
  - a copy of the apply draft with one distractor reason re-pointed at the correct option's id (approved, all six checks).

| Check | Result |
| --- | --- |
| `correctReason` renders with the stored text | pass (both items) |
| Every distractor reason renders with its option id, one per wrong option and none for the correct one | pass (3 of 3 on both items) |
| Every option renders with its stable id, and the correct-option id matches | pass (4 of 4 on both items) |
| Reasons stay attached to their option ids after the seeded shuffle (reason content matches option content) | pass |
| A reason mapped to the wrong option id is flagged by validation, and Publish stays disabled even with Approved and all checks ticked | pass |
| Reason fields are read-only after approval (no editable input, no "Add item") | pass |
| Publish gate: disabled while needs_review; enabled when approved with all checks; publish succeeds | pass |
| Real learner query on the published item returns only `_id, _rev, familyId, lessonId, options, question, responseFormat, type, version`, with no reason field or reason text | pass |

Cleanup: `pr1-smoke` deleted, browser profile (which held the CLI session token) removed. Production still has 0 assessments and 0 generation records.
