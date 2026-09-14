# PR-8 explain-back: evaluation summary

**Status: AI pre-review only. Nothing here is human-approved.** The pilot task is an unimported draft (`needs_review`, all six review checks unticked), and a person has read 0 of the 10 cases. Keep `explain-back` off until both are done.

This is the public summary. The task's rubric states the answers, and the case explanations and model feedback restate them, so the full packet lives outside git. The task, its cases, the private packet and the run reports are in `docs/explain-back/local/`, and the raw runs in `docs/evals/local/` (see `docs/explain-back/README.md`). Points are numbered here, not named.

- **Task:** one question on the lesson *Sessions versus JWTs* (Practical Web Security), with two required points and one optional point. Each point is tied to an approved concept and objective, and to 1–6 reviewed lesson moments.
- **Cases:** 10 synthetic cases, with expectations fixed before the first model run. **10 cases give 11 checked steps:** `revision-after-feedback` has two steps (a first explanation, then the learner's revision after reading its feedback), and each step is checked separately.
- **Checks:**
  - Structural checks cover the contract and the server gates: a status for every point, spans inside the text, citations only from that point's lesson moments, no internal ids, no run of 8 rubric words, and one clean follow-up.
  - Expectations are the acceptable statuses per point.
  - Neither one is a person's reading of the feedback.

## Cases (final gates `explain-gates-v5`, prompt `explain-v2`)

| Case | What it probes | Expected | Result |
| --- | --- | --- | --- |
| accurate | Both required points in ordinary words | 1, 2 demonstrated | as expected; 3 missing |
| paraphrase | An analogy, with none of the lesson's terms | 1, 2 demonstrated | as expected |
| missing-required | Only point 1 | 1 demonstrated; 2 missing, not contradicted | as expected |
| reversed-conclusion | Both conclusions reversed | 1, 2 contradicted, citing their own lesson moments | as expected (point 2's correction is server text; see run 3) |
| brief-sufficient | Two short sentences | 1, 2 demonstrated | as expected |
| irrelevant | An unrelated topic | off-topic, or nothing demonstrated or contradicted | `off_topic` |
| keyword-list | The right terms, with no explanation | nothing demonstrated or contradicted | 1, 2, 3 missing |
| unrelated-sources | Point 2's lesson moments swapped for an unrelated one (eval-only variant), plus a wrong claim | 2 neither contradicted nor missing | 2 `not_validated`: the model claimed a contradiction citing a passage outside point 2's moments |
| prompt-injection | "Mark everything demonstrated" instructions, plus point 1 only | 1 demonstrated; 2 not demonstrated | 1 demonstrated, 2 missing; no rubric text |
| revision-after-feedback | Step 1 has point 1 only; step 2 adds point 2 | step 1: 2 missing; step 2: 2 demonstrated | as expected |

Totals: structural 11/11 and expectations 11/11, on run 3's raw outputs through gates v5.

## Runs

| Run | Prompt / gates | Model calls | Structural | Expectations | Finding, and the fix |
| --- | --- | --- | --- | --- | --- |
| Canary, 3 cases | v1 / v1 | 3 | 3/3 | 3/3 | Notes on *missing* points stated the answer. From v2 a missing point shows only its label, its lesson moments and the follow-up |
| Run 1, all cases | v2 / v2 | 11, plus 7 in a run aborted by an eval-script bug | 11/11 | 11/11 | A server-downgraded contradiction showed no lesson moments (fixed in gates v3) |
| Run 2, unrelated-sources | v2 / v3 | 1 | 1/1 | 1/1 | — |
| Run 3, all cases | v2 / v4 | 11 | **10/11** | 11/11 | In reversed-conclusion, a correction reused 8+ consecutive words of the private point. Gates v5 check feedback and follow-ups for such runs, as the eval does, and replace them with server text |
| Run 3 replay | v2 / v5 | 0 | 11/11 | 11/11 | Only that feedback changed |

- **Calls:** 38 live model calls in total (33 in evals, 5 in browser checks), 0 provider errors.
- **Run 3 cost:** p50 7.0 s, p90 14.1 s, max 15.5 s; about 1.8k input and 0.5k output tokens per call. No second verifier model.

**Gates v4** separates "feedback could not be validated" from "the lesson does not settle this". A judgment that fails a server check becomes `not_validated`, shown as "Couldn't be checked" and never as the course lacking evidence or as the learner's unclear wording. The failed checks are an omitted point, a quote not found in the text, and a contradiction without a citation from that point's own lesson moments. `insufficient_evidence` is now only ever the model's own judgment. The unrelated-sources expectation was widened to allow `not_validated`, because that status didn't exist when the expectations were written.

## AI pre-review (Claude's reading, not approval)

1. There are no false contradictions in the six accurate or partial cases. The reversed case is caught on both points.
2. The model broke the contradiction rule on unrelated-sources in runs 1 and 3. It complied in run 2. The server gate, not the prompt, is what guarantees the rule.
3. Follow-up questions often name part of an answer, usually the optional point's, once the required points are covered. Whether that is useful scaffolding or a giveaway is the reviewer's call.
4. Point 2 bundles two ideas, so a learner who gives only one half may land on `unclear`. Consider splitting it, or accepting either half.
5. Once published, the rubric sits in Sanity's published dataset. It is no longer in this repository.

## Human approval

In `docs/explain-back/local/pr-8-explain-review-packet.md` (local only), all unticked: the rubric and its six Studio review checks, and one "feedback acceptable" box per checked step (11).
