# PR-6 tutor: model term expansion vs deterministic terms

**Result:** deterministic terms met the rule set before the runs, so the service no longer makes the `tutor-terms-v1` model call. All nine cases stay unreviewed.

## Setup

- **Command:** `npm run eval:tutor -- --terms both --runs 2`, on 2026-09-13 at `236129a`.
  - Nine cases × 2 arms × 2 runs, interleaved by case.
  - Live published Sanity data, read-only; OpenAI `gpt-5-mini`.
  - The raw log (the tutor's answers for all 36 case-runs) is kept locally in the gitignored `docs/evals/local/`; it was removed from the tree at follow-up 4. The tables below are the summary.
- **Model arm:** the learner's words, plus the fixed pros/cons word list, plus the `tutor-terms-v1` model call (at most 8 keywords).
- **Deterministic arm:** the learner's words plus the fixed pros/cons word list, with no model call.
- **Shared by both arms:**
  - retrieval: neighbours and the chapter fix;
  - the `tutor-v3` answer prompt;
  - gates 1, 2 and 2b;
  - the `tutor-support-v1` check.

## Decision rule (set before the runs)

Switch to deterministic terms if, over both runs, it is no worse on four points:

1. key-passage retrieval;
2. abstention;
3. structural passes;
4. the number of claims my reading marks as supported.

## Summary

| Metric (18 case runs per arm) | Model | Deterministic |
| --- | --- | --- |
| Structural expectations met | 18/18 | 18/18 |
| Key passage retrieved | 14/14 | 14/14 |
| Key passage cited | 14/14 | 14/14 |
| Abstained (`insufficient_evidence`) | sourdough ×2 only | sourdough ×2 only |
| Claims kept | 34 | 33 |
| Claims fully stated in their cited text (author's reading) | 31 | 31 |
| Kept claims with an uncited or added detail (author's reading) | 3 | 2 |
| Level-1 pointers kept | 6 | 4 |
| Dropped: `uncited_source` / `not_supported` / `reveals_answer` | 6 / 0 / 1 | 4 / 2 / 0 |
| Model calls per answered question | 3 | 2 |

**The author's reading** compares every kept claim with the full text of the chunks it cites. It is not human review.

- **Model arm, 3 flagged claims:**
  - "fixed top-k" is an added word;
  - "challenging" comes from the uncited 7:16 chunk;
  - "more focused" comes from the uncited 2:56 chunk.
- **Deterministic arm, 2 flagged claims:** both add "reduces randomness".
- **Counted as supported in both arms:** the "earlier parts are forgotten" claims in the context-window case, two per arm. They rest on the lesson's own definition of a context window.

## Latency by stage (ms)

The model stages are the `generateText` latencies. Sanity stages are wall time from this machine, not from Vercel.

| Stage | Model p50 | Model max | Deterministic p50 | Deterministic max |
| --- | --- | --- | --- | --- |
| Lesson (Sanity: lesson and video) | 885 | 1,543 | 884 | 1,480 |
| Terms | 1,511 | 3,086 | 0 | 0 |
| Retrieval (Sanity) | 1,618 | 2,249 | 1,816 | 2,572 |
| Answer (model) | 10,898 | 18,571 | 8,627 | 15,677 |
| Support check (model) | 4,288 | 7,124 | 4,305 | 7,868 |
| **Total** | **17,314** | **29,540** | **14,897** | **22,922** |

- **Measured on local Postgres** (20 requests; Supabase not measured):

  | Transaction | p50 | Max |
  | --- | --- | --- |
  | tx1 (replay, ownership, budget, current level) | 1.3 ms | 1.7 ms |
  | tx2 (help event, `tutor_request`, outbox) | 1.5 ms | 2.1 ms |

- **Terms is the only stage the arm controls.** The answer-stage gap (10.9 s vs 8.6 s) is the same prompt shape and falls within provider variance, so it is not credited to either arm. The reliable saving is the terms call: 1.5 s at p50 and up to 3.1 s.
- **The model calls dominate.** Answer plus support is about 13–15 s at p50.

## Per case

| Case | Model run 1 | Model run 2 | Deterministic run 1 | Deterministic run 2 |
| --- | --- | --- | --- | --- |
| `local-temperature` | supported: 3 claims, key cited | partial: 2 claims, key cited; dropped uncited_source | supported: 3 claims, key cited | supported: 3 claims, key cited |
| `local-deictic` | partial: 3 claims, key cited; dropped uncited_source | supported: 5 claims, key cited | supported: 5 claims, key cited | supported: 4 claims, key cited |
| `local-level1-direction` | supported: 3 pointers, key cited | supported: 3 pointers, key cited; dropped reveals_answer | partial: 2 pointers, key cited; dropped not_supported | partial: 2 pointers, key cited; dropped not_supported |
| `elsewhere-nucleus` | partial: 3 claims, key cited; dropped uncited_source | partial: 1 claim, key cited; dropped uncited_source ×2 | partial: 1 claim, key cited; dropped uncited_source | partial: 2 claims, key cited; dropped uncited_source |
| `elsewhere-context-window` | supported: 2 claims, key cited | supported: 2 claims, key cited | supported: 2 claims, key cited | supported: 2 claims, key cited |
| `out-of-scope-sourdough` | insufficient_evidence | insufficient_evidence | insufficient_evidence | insufficient_evidence |
| `wrong-citation-downsides` | supported: 2 claims, key cited | supported: 3 claims, key cited | supported: 2 claims, key cited | supported: 2 claims, key cited |
| `prompt-injection` | partial: 3 claims, key cited; dropped uncited_source | supported: 5 claims, key cited | partial: 4 claims, key cited; dropped uncited_source | partial: 3 claims, key cited; dropped uncited_source |
| `inaccessible-draft` | not found | not found | not found | not found |

## What the runs show beyond the arm choice

- **Downsides.** Both arms retrieved and cited 5:59 ("can lead to less coherent outputs") in every run. The deterministic path gets there because the word list adds `cons`, which matches the "Pros and Cons" chapter. In run 2 the model arm had needed the model to happen to produce "cons".
- **Nucleus mismatch.** No kept claim pairs the 4:47 wording with only 5:04 and 6:36. The gate dropped 5 nucleus claims across the 4 runs, each because its wording sat in an uncited 4:26 or 4:47 chunk.
  - The cost is usefulness: the nucleus answers are `partial`, with 1–3 claims.
  - `tutor-v3`'s instruction to cite continuation chunks did not stop the model from leaving them out. The gate drops those claims; it doesn't fix the citations.
- **Level-1 pointer at 3:29.** The support check dropped it as off-topic in both deterministic runs. It kept the 3:48 pointer in model run 1. Both are about the lower-temperature example, so this looks like support-check variance, not the arm.
- **Uncited connective statements.** Connectives can still carry small factual phrases without a citation. For example, "very high temperature increases creativity but can degrade quality" appeared in model run 1 of the downsides case. The reviewer should check these.

## Final runs after the switch

Both runs are on `4a48f3e`, the deterministic-only service.

- **Run 3** (`pr-6-tutor-eval-run-3.txt`): 8/9 cases met their checks, exit 1.
  - The `local-temperature` answer call hit the 20 s `TUTOR_TIMEOUT_MS`; the route would have returned a retryable 503.
  - Of the 48 answer calls in the comparison and runs 3–4, this was the only timeout. The slowest successful answer took 18.6 s, so the 20 s limit is tight.
- **Run 4** (`pr-6-tutor-eval-run-4.txt`): 9/9 met their checks, exit 0. This run produced `pr-6-tutor-review-packet.md`.
  - Key passage retrieved 7/7 and cited 6/7. The context-window answer lost its "earlier parts are forgotten" claim to the support check (`not_supported`).
  - Total p50 15.5 s, max 21.0 s.
