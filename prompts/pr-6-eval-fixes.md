# PR-6 follow-up: fix the evaluation findings (#12)

## Goal

Fix the four failures recorded in draft PR #12 without enabling the tutor:

1. **The retrieval miss.** `wrong-citation-downsides` never reaches the lesson's "Pros and Cons" section.
2. **Unsupported claims.** Claims survive whose cited chunks do not state them, for example "nonsensical tokens" cited to a top-k chunk.
3. **Level-1 leakage.** A level-1 answer states the conclusion.
4. **A wrong evaluation assertion.** The `wrong-citation-downsides` check fails an acceptable `partial` or `insufficient_evidence` answer.

Then add regression tests and re-run the nine-case evaluation. Human review stays pending (`reviewed: false`), and the `tutor` flag stays off. A valid citation ID is never treated as proof that a claim is supported.

The work lands on branch `feat/pr-6-tutor-endpoint` (#12), as a second commit on top of `4ece6dd`. Nothing is deployed, and no migration is applied outside the local test Postgres.

## Findings from inspection

- **Retrieval miss:**
  - The question's terms are `downside`, `high` and `temperature`. The window at 4:10 matches `high` and `temperature` strongly, so the search never widens.
  - The answer sits under the chapter "Pros and Cons" (5:10–7:30) and uses the words "cons", "less coherent" and "increased randomness". None of them is a question term.
  - Of the 120 videos, 58 have chapters. The tutor reads none of them today.
- **Unsupported claims:** the only support check is one shared content word per citation, which a statement can pass while adding facts its chunk doesn't state.
- **Level-1 leakage:** level 1 is enforced only by prompt wording. The output schema still lets the model write explanatory claims.
- **Evaluation assertion:** `expect.citedWithin` is applied unconditionally. The case notes say `partial` or `insufficient` is acceptable, but the checker cannot express "either / or".

## Decisions (for approval)

1. **Retrieval: expand the terms, search chapters first, and always search the lesson.**
   - **Term expansion.** A new bounded model call (`tutor-terms-v1`) returns at most 8 lowercase single-word variants of the question, for example `cons` and `drawback` for "downsides".
     - It uses minimal reasoning and at most 96 output tokens, following the search interpretation precedent.
     - Every variant passes through `sanitizeTerms`, the same guard search uses, before reaching GROQ as a param.
     - If the call fails, the tutor falls back to the learner's own terms and does not return 503, like search. The question is sent to the model only for this call and the answer call; nothing is stored.
   - **Chapters first.** Video records now also load `chapters[0...40]{startSeconds, label}`.
     - For the lesson tier, a chapter whose label matches an expanded term contributes the chunks inside its span first, at most 8. Keyword-matched chunks from the transcript fill any remaining room.
     - This follows the ranking rule in AGENTS §9: chapters first, then transcript chunks.
   - **The lesson tier now always runs** when the question has topic terms, not only when the window has no strong match. The course tier still runs only when neither the window nor the lesson has a strong match.
     - Consequence: `scope` will usually be `lesson` for topical questions, and `window` only for questions with no topic words.
     - The caps are unchanged: 30 chunks and 9,000 characters.
2. **Unsupported claims: a server-side support check, kept distinct from proof.**
   - A second bounded model call (`tutor-support-v1`, reasoning effort `low`) receives each surviving claim with **only the text of the chunks it cites**. It returns a verdict per claim.
     - A claim is `supported` only if every factual part of it is stated in those chunks.
     - Paraphrase is fine. An inference, generalization or added detail is not.
   - The server drops every claim that isn't `supported`. The answer then becomes `partial`, or `insufficient_evidence` if no claim remains.
   - The word-overlap floor stays in place as a cheap pre-filter.
   - If the check fails (timeout, provider error or invalid output), the request returns 503 and records nothing. A claim is never kept unchecked.
   - What is recorded, and what isn't:
     - The `tutor_answered` outbox payload gains `droppedClaims` and `supportCheck: 'tutor-support-v1'`.
     - The code, the PR and the prompt all state that this is a model-assisted check, not proof.
     - The evaluation prints each verdict for the reviewer.
   - No migration change.
3. **Level 1: an answer format that cannot hold an explanation.**
   - At level 1 the model returns only `{status, pointers: EvidenceRef[] (1–3), guidingQuestion | null}`. There is no free-text claim field.
   - The server writes each pointer's text from stored records: "The lesson covers this at `<label>`.", with the citation attached. This adds a new statement kind, `pointer`, to the response contract; like a claim, it must carry a citation.
   - The support check also covers level 1:
     - a pointer survives only if its chunk addresses the question;
     - a guiding question that states or gives away the answer is dropped, and the pointers are kept.
   - Levels 2 and 3 keep the claim format.
4. **Evaluation.**
   - The expectation checker moves from the script to `lib/tutor/eval-check.ts`, so it can be unit-tested. It gains:
     - `anyOf`: at least one group of expectations must hold;
     - `kinds`: the statement kinds that are allowed;
     - `maxClaims`.
   - `wrong-citation-downsides` becomes `anyOf: [{citedWithin: [310, 450]}, {status: [partial, insufficient_evidence]}]`.
   - The level-1 case allows only `pointer` and `connective` statements, and zero claims.
   - The evaluation prints each claim's support verdict and each dropped claim.
   - The same nine cases are re-run, and all stay `reviewed: false`. The output is saved as `docs/evals/pr-6-tutor-eval-run-2.txt`.
5. **Versions:**
   - The tutor's prompt version becomes `tutor-v2`. It is recorded in `tutor_request.prompt_version` and in the outbox.
   - The new tasks are `tutor-terms-v1` and `tutor-support-v1`.
   - No change to the help policy, the migration or the route contract, apart from the new statement kind.
6. **Latency and cost** (to be measured, not assumed):
   - Up to three model calls per answered question: the term expansion runs in parallel with the database check, then the answer, then the support check.
   - Expected p50 is about 12–15 s. Each call keeps its own timeout.
   - The run-2 evaluation reports the measured figures.

## Expected files

- **Modified:**
  - `lib/ai/tutor.ts` (terms, support check, level-1 format, `pointer`);
  - `lib/tutor/retrieve.ts` and `lib/tutor/source.ts` (chapters, the always-on lesson tier, expanded terms);
  - `lib/tutor/service.ts`;
  - `lib/learner/contracts.ts` (`pointer`);
  - `scripts/eval-tutor.mts`;
  - `scripts/tutor-eval-cases.json`;
  - the prompt notes in `prompts/pr-6-tutor-endpoint.md`;
  - the test fixture `lib/tutor/test-source.ts` (its mocks route by task).
- **New:**
  - `lib/tutor/eval-check.ts` and its `.test.ts`;
  - `docs/evals/pr-6-tutor-eval-run-2.txt`.
- **Tests:** `lib/ai/tutor.test.ts`, `lib/tutor/retrieve.test.ts`, `lib/tutor/tutor.db.test.ts` and `lib/learner/contracts.test.ts` are extended.

## Regression coverage (named tests)

- **Retrieval:**
  - an expanded term matches a chapter label, so that chapter's span is retrieved even though the window matches strongly (the downsides shape, built as a fixture);
  - the lesson tier always runs when there are topic terms;
  - with no topic terms, only the window is searched;
  - when term expansion fails or returns unsafe tokens, only sanitized learner terms reach the GROQ params.
- **Support:**
  - a claim the verdict marks unsupported is dropped, and the answer becomes `partial`;
  - with every claim dropped, the answer is `insufficient_evidence`;
  - the checker sees only the cited chunks' text;
  - a checker failure → `AiCallError`, and in the database test nothing is recorded;
  - a valid citation ID with a failing verdict is still dropped.
- **Level 1:**
  - the level-1 schema rejects free-text claims;
  - pointer text is built by the server;
  - a guiding question that leaks the answer is dropped;
  - the response contract accepts `pointer` only with citations.
- **Evaluation checker:**
  - `anyOf` passes an `insufficient_evidence` answer for the downsides case;
  - it fails an unrelated wrong answer;
  - `kinds` and `maxClaims` are enforced.

## Checks

- Under Node 22: `npm run typecheck`, `npm run lint`, `npm test` with the local Postgres on port 54329, and `npm run build`.
- `npm run eval:tutor` runs the nine cases once. The result is reported exactly as it comes out, pass or fail.
- The Postgres stays running afterwards.
- No deployment and no Supabase access.

## Not in this change

- OCR/VLM evidence. PR-2 is not in this stack, and #12 documents that.
- Embeddings.
- An outbox dispatcher. Learner evidence and mastery don't depend on one (documented in #12).
- The UI.
- Reviewing the cases. That is yours.

## Implementation notes (2026-09-13)

These differ from, or go beyond, the plan above:

- **Term expansion runs after tx1, not in parallel with it.** A request rejected for the budget, ownership, or a replayed key never reaches the model, which costs about 1.7 s at p50.
- **Chapter budget is split evenly.** The chunks between the two matched chapters are divided equally, and chunks inside the window are skipped. Otherwise the chapter around the playhead ("Temperature") could use the whole budget and crowd out "Pros and Cons". A fixture test covers this case.
- **Strong matches count only the learner's own words.** The course tier is skipped only when a chunk matches strongly on the learner's own terms. Model variants widen recall and ranking but never stop the search.
- **Term cap.** `contentTerms` now caps a question at 12 terms. An uncapped 500-character question could exceed the GROQ query builder's term bound and return 500. There is a regression test.
- **Eval failures.** A model failure during the evaluation is now reported as a failed case, instead of crashing the run.
- **Outbox field name.** The field is `droppedStatements`, not `droppedClaims`, because it also counts dropped level-1 pointers and leaking guiding questions.

### Run 2 (`docs/evals/pr-6-tutor-eval-run-2.txt`)

9/9 cases met their structural checks, and all nine remain `reviewed: false`.

Model-call latency and cost:

| Task | p50 | Max | Output tokens (max) |
| --- | --- | --- | --- |
| `tutor-terms` | 1.7 s | — | 58 |
| `tutor-answer` | 11.3 s | 15.8 s | 1,172 |
| `tutor-support` | 4.9 s | 6.4 s | 489 |

End to end, a typical answer takes about 18 s.

Known residuals, found by reading the output against the full chunk text:

1. **The downsides answer is `partial` and honest, but depends on term expansion.**
   - Its claims are stated in the cited chunks. The chunk at 5:41 says "on the con side … excessive temperature".
   - The actual downside ("less coherent outputs", at 5:59) was retrieved only when the expanded terms included `cons`. This run's expansion (`heat, drawback, risk, effect, impact`) did not include it.
   - With `con`, retrieval does return 5:59, as a replay confirmed. So the chapter and term fix works, but it depends on nondeterministic term expansion.
2. **One nucleus-sampling claim adds a detail its cited chunks don't state.**
   - The claim adds "depending on how sharp or flat the distribution is". That wording is at 4:47, which it does not cite; it cites 5:04 and 6:36.
   - The support check accepted it. The check is model-assisted and demonstrably fallible.
3. **Level 1 no longer states the conclusion.**
   - It returns two server-written pointers and a guiding question that does not give the answer.
   - One pointer the support check judged off-topic was dropped (3:48).

### Pilot gate

Still **not met**:

- none of the nine cases has been reviewed by a person;
- residual 2 is a known claim that isn't stated in its cited sources.

The `tutor` flag stays off.
