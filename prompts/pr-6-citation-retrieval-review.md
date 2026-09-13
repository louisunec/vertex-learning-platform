# PR-6 follow-up 2: citation mismatch, deterministic retrieval, review packet (#12)

## Goal

This work lands on `feat/pr-6-tutor-endpoint` as new commits. PR #12 stays a draft, the `tutor` flag stays off, and nothing is deployed or migrated. It covers seven items:

1. **Citation mismatch.** Fix the known nucleus-sampling citation mismatch: a claim uses wording from 4:47 but cites 5:04 and 6:36. Add a regression test that rejects this exact pairing, even when the model support check accepts it.
2. **Downsides retrieval.** Make it reach the "less coherent outputs" passage at 5:59 without relying on the model to produce "cons".
3. **Stage latency.** Measure latency for each stage.
4. **Deterministic terms.** Evaluate replacing the `tutor-terms-v1` model call with deterministic retrieval. Compare answer usefulness, citation support, abstention and latency on the same nine cases. Add no verifier call.
5. **Review packet.** Prepare a concise nine-case human review packet. Human review stays pending (`reviewed: false`).
6. **OCR/VLM follow-up.** Record OCR/VLM integration as an explicit follow-up.
7. **Report.** Record the comparison and the latency figures.

## Findings from inspection

The live `production` data was read only.

- **The nucleus mismatch.**
  - The claim says nucleus sampling balances diversity and coherence "by allowing more or fewer tokens depending on how sharp or flat the probability distribution is".
  - That wording is in chunk 287 (4:47), which says the candidate set grows or shrinks with how sharp the distribution is.
  - The claim cites 304 (5:04) and 396 (6:36). Chunk 396 is about the cons of top-k.
  - Chunk 287 was in the evidence (Top-p chapter). The model cited the wrong chunks, and the `tutor-support-v1` call accepted them.
  - Gate 2, the one-shared-word floor, passes easily, because 396 contains "balance", "diversity" and "coherence".
- **A deterministic rule** can detect this without another model call: a claim's words that none of its cited chunks contain, but which one *uncited* retrieved chunk does contain.
  - **Rule:** for each claim, collect its content words, minus the question's own words. Keep the words that no cited chunk contains (the same prefix matching as retrieval). If one uncited retrieved chunk contains **3 or more** of them, the claim's detail came from a source it doesn't cite. Drop the claim.
  - **Calibration:** I replayed all 43 cited claims from runs 1 and 2 against the full lesson transcript.
    - At a threshold of 3, the rule flags 12 claims, including the known nucleus pairing (+5 words) and the run-1 nucleus claim (+3).
    - On my reading, all 12 contain a detail that isn't in their cited chunks. Most are sentences that continue into the next chunk. For example, the "more focused and deterministic" wording is at 176 (2:56), but the claim cites only 157 (2:37).
    - None of the unflagged claims has a flagged-size gap. This is my reading, not human review.
  - **Cost:** today's model often cites only the first chunk of a sentence that spans two. Dropping those claims will make more answers `partial`, unless the model also cites the continuation. The eval measures this.
- **The downsides miss.**
  - The learner's own terms are `downside`, `high` and `temperature`.
  - Chunk 341 (5:41, which introduces the cons of an excessive temperature) matches `temperature` and `high`. The answer is in the next chunk, 359 (5:59, "can lead to less coherent outputs"), which matches none of those terms.
  - Today, 359 is reached only through the "Pros and Cons" chapter, and only when the model's terms include "cons".
  - Of 440 chapter labels across 58 chaptered videos, 23 use pros/cons wording: "Pros and Cons", "Advantages of sharding", "Disadvantages of sharding", "Benefits of …", "Limitations, …" and "Server Component Downside #1".
- **A chapter-selection bug** found on the way.
  - Chapters that tie on label hits are taken in time order, even when their whole span is inside the window and yields nothing.
  - With deterministic terms, the nucleus question (at 0:40) picks "Random Sampling" (1:05–1:49, all inside the window) over "Top-p Sampling".
- **Latency today** (run 2, p50):

  | Stage | p50 |
  | --- | --- |
  | Terms | 1.7 s |
  | Answer | 11.3 s |
  | Support | 4.9 s |

  About 18 s end to end. The Sanity and database stages were never measured.

## Decisions (for approval)

1. **Citation gate (deterministic, gate 2b).**
   - The rule above goes in `prevalidateExplanation`, with a new drop reason, `uncited_source`, and the constant `UNCITED_SOURCE_TERMS = 3`.
   - It applies to claims only; pointers carry server-written text.
   - A claim it drops never reaches the support check. Any rejection by the support check still stands.
   - The claim's words are not capped at 12 for this check: `contentTerms` gains an optional `limit`.
   - It flags a claim's wording that sits in an uncited source. It can't prove the cited sources support the claim, so it narrows the gap without closing it.
2. **Answer prompt `tutor-v3`.**
   - One added rule: sources are consecutive transcript excerpts, and a sentence often continues into the next one. A claim must cite every source whose wording it relies on, including the one where the sentence ends.
   - Sources are listed in time order, with `endSeconds` added.
   - There is no new model call.
3. **Deterministic retrieval (downsides fix without "cons" from the model).**
   - **Neighbours.** The top 3 keyword hits in the lesson tier each bring along the chunk right before and right after them.
     - That is at most 6 extra chunks, fetched with 3 bounded `loadWindow` queries run in parallel.
     - Neighbours are ranked right after their hit.
     - Transcript chunks are at most 30 s long and split sentences, so this finds 359 from 341 with no synonym at all.
   - **Pros/cons word list.** The vocabulary is fixed, in `lib/tutor/terms.ts`, as two groups:
     - {downside, drawback, disadvantage, limitation, weakness, pitfall, cons}
     - {upside, advantage, benefit, strength, pros}

     A question word from a group adds that group's other words, as sanitized terms, at most 4, still under the cap of 12.

     `pros` and `cons` are used instead of `pro` and `con`, because `pro*` would also match "probability".

     This matches the label data above. It is a word list, not a model.
   - **Chapter selection** skips chapters that have nothing outside the window before it picks the top 2.
   - Caps are unchanged: 30 chunks and 9,000 characters.
4. **Comparison design (fixed before any run).**
   - **Arm M (current):** the `tutor-terms-v1` model call, plus the word list, merged as today.
   - **Arm D:** learner terms plus the word list, with no model call.
   - Both arms share the new retrieval, the `tutor-v3` answer and the gates, and use the same support check.
   - `npm run eval:tutor -- --terms model|deterministic --runs 2` runs both arms on the nine cases. The runs are interleaved by case to spread provider drift.
   - That is about 90 `gpt-5-mini` calls against read-only production Sanity. No database is used.
   - **Metrics for each case and arm:**
     - *Key passage retrieved*: the case's new `keySeconds` range, checked deterministically.
     - *Key passage cited.*
     - *Claims kept and dropped*, by reason.
     - *Abstention*: sourdough must abstain, and the other cases must not.
     - *Structural pass.*
     - *Stage latency.*
     - *Citation support* on my reading of every kept claim against the full quoted sources. This is labelled as the author's reading, not human review.
   - **Decision rule:** switch the service to arm D if, over both runs, arm D is no worse than arm M on key-passage retrieval, abstention and structural passes, and keeps at least as many claims my reading marks as supported.
     - If it switches, `lib/ai/tutor-terms.ts` and its model call are removed, and the comparison stays as evidence.
     - Otherwise the service keeps arm M, and I report why.
5. **Stage timing.**
   - The eval times each stage per case, then reports p50 and max per arm:
     - `lesson` (Sanity)
     - `terms`
     - `retrieval` (Sanity)
     - `answer`
     - `support`
     - `total`
   - The database transactions are timed separately with a scratchpad harness. It wraps `db.begin` around `askTutor`, with the fixture source and a mock model, 20 requests on the local Postgres (port 54329).
   - These database figures are labelled local only, because Supabase is not measured. No service code changes for timing.
6. **Review packet.**
   - `npm run eval:tutor -- --packet docs/evals/pr-6-tutor-review-packet.md` writes it from the final run of the chosen arm.
   - **Per case:**
     - the question, the lesson and the playhead;
     - the help level, stating that the case sets it and the help policy is bypassed;
     - the status and the scope;
     - each statement with its kind;
     - for each claim or pointer, the cited timestamps with links and the **full quoted chunk text**;
     - any dropped statements, with their reasons;
     - the case's reviewer note;
     - empty verdict lines per claim (`supported / not supported / wrong source`) and per case (`answer acceptable? yes / no`).
   - The header states that `reviewed: false` stays until you change it, and that model and deterministic checks are not proof.
7. **Final run.** After applying the decision, one more run of the nine cases produces `docs/evals/pr-6-tutor-eval-run-3.txt` and the packet. The comparison goes in `docs/evals/pr-6-tutor-comparison.md`, with the raw logs in `docs/evals/pr-6-tutor-comparison-raw.txt`.
8. **OCR/VLM follow-up.**
   - Open GitHub issue "PR-6 follow-up: OCR/VLM visual evidence in the tutor". It will say that PR-2 (`68c2f25`, `feat/pr-2-visual-index`) is outside this stack, and that the tutor is transcript-only until it lands and its evidence joins retrieval, under the same citation gates.
   - Link it from the PR #12 body and the prompt notes.
9. **Versions:**
   - `tutor-v3` is recorded in `tutor_request.prompt_version` and the outbox.
   - `tutor-support-v1` is unchanged.
   - There is no migration and no contract change: `uncited_source` is internal, and the outbox keeps a count only.

## Expected files

- **Modified:**
  - `lib/ai/tutor.ts`: gate 2b, `contentTerms` limit, `tutor-v3` rule and source order.
  - `lib/tutor/retrieve.ts`: neighbours and the chapter skip.
  - `lib/tutor/service.ts`: the chosen term path.
  - `scripts/eval-tutor.mts`: arms, runs, timing and packet.
  - `scripts/tutor-eval-cases.json`: `keySeconds`, with `reviewed: false` kept.
  - `lib/tutor/eval-check.ts`: `keySeconds` in the schema.
  - `lib/tutor/test-source.ts`: a fixture shaped on the real lesson.
  - `prompts/pr-6-tutor-endpoint.md`: notes.
  - The PR #12 body.
- **New:**
  - `lib/tutor/terms.ts` and its test.
  - The three `docs/evals` files named above.
- **Removed, only if arm D wins:** `lib/ai/tutor-terms.ts` and its uses.

## Regression tests (named)

- **Citation gate** (`lib/ai/tutor.test.ts`). The fixture copies the real chunk text of 157, 266, 287, 304 and 396.
  - The exact run-2 nucleus claim, citing [304, 396], is dropped as `uncited_source` **while the mock support check answers `supported`**. It is not sent to the check.
  - The same claim citing [266, 287, 304] is kept.
  - A claim whose missing words are spread across chunks, at most 2 per chunk, is kept.
  - Question words don't count as missing.
  - A sentence split across chunks (157 alone, where 176 is uncited) is dropped, but kept when it cites [157, 176].
- **Retrieval** (`lib/tutor/retrieve.test.ts`). The fixture follows the real layout: a "Pros and Cons" chapter, the playhead at 250, an "excessive temperature" chunk followed by a "less coherent" chunk.
  - With deterministic terms and **no model**, the "less coherent" chunk is in the evidence.
  - It is still there with the chapters removed, through the neighbour rule alone.
  - A chapter fully inside the window doesn't take a chapter slot.
  - The neighbour count stays within its cap.
- **Terms** (`lib/tutor/terms.test.ts`):
  - "downsides of a high temperature" includes `cons`;
  - "advantages" includes `pros`;
  - there are no `pro` or `con` stems;
  - the result is capped;
  - unsafe input yields only safe tokens.
- **Service:** if arm D wins, a database test asserts that a tutor request makes only the answer and support calls, with no terms call.

## Security

- Word-list terms and neighbour ranges go through the same `SAFE_TERM` validation and parameterized GROQ as today. Only numbers are inlined.
- Neighbour fetches are bounded (3 queries, 5 chunks each), and the whole transcript never enters the request path.
- No new data leaves the server, and question, answer and source text are still never stored.
- The eval and the packet read published content only.

## Checks

- Under Node 22: `npm run typecheck`, `npm run lint`, `npm test` (with the local Postgres on port 54329) and `npm run build`.
- The comparison runs, then the final `npm run eval:tutor`. Each result is reported exactly as it comes out.
- Postgres keeps running, and there is no deployment or Supabase access.

## Manual tests (for you)

1. Open `docs/evals/pr-6-tutor-review-packet.md` and mark each claim's verdict. Set `reviewed: true` in `scripts/tutor-eval-cases.json` only for cases you have reviewed.
2. `npm run eval:tutor -- --case elsewhere-nucleus`: no kept claim pairs 4:47 wording with only 5:04 and 6:36.
3. `npm run eval:tutor -- --case wrong-citation-downsides`: the evidence includes 5:59, and any downsides claim cites it.

## Not in this change

- OCR/VLM (issue only).
- Embeddings.
- The outbox dispatcher.
- The UI.
- Enabling `tutor`.
- Reviewing the cases.

## Implementation notes (2026-09-13)

These differ from, or go beyond, the plan above:

- **Gate 2b words: `contentTerms` is unchanged.**
  - The gate uses its own uncapped topic words and ignores word endings: `-ies`, `-ing`, `-es`, `-ed`, `-s` and `-ly`.
  - Without this, "probabilities" would count as missing from a chunk that says "probability". Nothing else changed.
  - **Recalibration:** with the implemented gate, 13 of 42 earlier claims are flagged. On my reading, each takes wording from an uncited chunk.
    - The earlier count of 12 had missed one: a run-1 claim whose words fell past the 12-word cap.
    - The calibration used every chunk of the lesson. In production the gate sees only the ≤30 retrieved chunks, so it catches somewhat less.
- **The neighbour rule does not find 5:59 for the downsides question.** That part of the plan was wrong.
  - Chunk 341 matches only "temperature" (the "higher" I counted is in 322). It ties with earlier chunks, so it is not a top hit.
  - The deterministic fix for downsides is the word list: `cons` matches the "Pros and Cons" chapter.
  - The neighbour rule still adds the chunk that finishes a hit's sentence. Its regression test uses "What does an excessive temperature cause?" (5:41 → 5:59).
- **`mergeTerms`** used to cut the learner's words to 8 even when nothing was added. That dropped "temperature" from the prompt-injection question. It now cuts only to make room for list words.
- **Decision applied.** The deterministic arm met the rule; see `docs/evals/pr-6-tutor-comparison.md`. As a result:
  - `lib/ai/tutor-terms.ts`, its tests, the mock's `terms` task and the eval's `--terms` option are removed;
  - the service makes two model calls per answer: the answer and the support check;
  - a database test asserts exactly two calls.
- **Stage latency.** Sanity reads take about 0.9 s (lesson) and 1.6–1.8 s (retrieval) at p50 from this machine; neither had been measured before.
- **OCR/VLM follow-up** is issue #13.
