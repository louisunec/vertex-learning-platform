# PR-6 follow-up 3: replay race, sentence-complete evidence, transcript copying (#12)

The `tutor` flag stays off, and PR #12 stays a draft. Full live evaluations are paused; only the targeted checks below will run. There is no deployment and no production migration.

## Findings from inspection

### 1. The concurrency failure is an application defect (PR-4), not a test issue

- **Test:** `attempts.db.test.ts` › "records concurrent duplicate requests exactly once" fails intermittently. This session it failed in 5 of 6 runs on the untouched PR-5 base `0cfb0a0`.
- **Cause.** `submitAttempt`'s first transaction reads the idempotency key (`replayByKey`), then runs a *separate* statement asking whether the task instance already has an attempt.
  - Under Postgres READ COMMITTED, each statement sees a fresh snapshot.
  - If the duplicate commits between the two reads, the key lookup finds nothing, the instance check finds an attempt, and the request returns `already_submitted` (HTTP 409).
  - The correct result is the replayed grade, because the retry carries the same key and the same body.
- **Reproduction.** A scratch script pauses the transaction right after the key lookup, runs the duplicate to completion, and then resumes. It returns `already_submitted` in 3 out of 3 runs; pausing before the lookup returns the replay in 3 out of 3.
- **Impact.** A client retry during a slow first request gets "This task was already answered" instead of its own result. No evidence is double-counted, because the unique indexes still hold.
- **The same pattern exists in the PR-6 tutor** (`askTutor` tx1).
  - It checks `tutor_request` by key, then `help_event` by key.
  - If a concurrent tx2 commits between those checks, the request gets `idempotency_key_reused` ("used for a different submission") instead of `already_answered`. Both are 409, but the code and message are wrong.
- **`/api/help` (PR-5) is not affected.** It does a single key lookup per transaction and re-checks after the insert.

### 2. The transcript text is third-party, not cleared, and already public

- **Sources.** Both quoted lessons use third-party YouTube videos:
  - "Temperature and sampling": `-BBulGM6xF0`;
  - "Tokens and context windows": `-QVoIxEpFkM`.
- **Rights.** `scripts/ingest-videos.mts` fetched their captions from YouTube's public player endpoint. No video document in the dataset carries a licence or permission field (0 of all), and the repo has no licensing statement. I cannot confirm permission to redistribute.
- **The repository is public** (`louisunec/vertex-learning-platform`). All of this is pushed to `origin/feat/pr-6-tutor-endpoint` and visible in PR #12:

| File | Copied text | Commit |
| --- | --- | --- |
| `lib/tutor/test-source.ts` | the **full** sampling transcript: 27 chunks, 1,237 words | `8a5e148` |
| `lib/ai/tutor.test.ts` | 7 full chunks | `2a2666d` |
| `docs/evals/pr-6-tutor-review-packet.md` | 35 full-chunk quotes, 14 unique chunks, 644 words (**52% of the transcript**), plus context-window lesson quotes | `604ea16` |
| `docs/evals/pr-6-tutor-eval-run-{1,2,3,4}.txt` | 42, 41, 38 and 35 excerpts of ≤160 characters | `3a60177`, `b5e8899`, `604ea16` |
| `docs/evals/pr-6-tutor-comparison-raw.txt` | 157 excerpts of ≤160 characters | `604ea16` |
| `lib/tutor/retrieve.test.ts`, `eval-check.test.ts`, `prompts/*.md`, `docs/evals/pr-6-tutor-comparison.md` | short phrases (≤ 8 words) | various |

- **History.** A new commit can remove the text from the branch tip, but it stays in history and in GitHub's PR views until the history is rewritten and force-pushed. I will not rewrite history without your agreement.

### 3. The lexical citation check is a heuristic

- Gate 2b (`uncited_source`) only notices wording that sits in an uncited retrieved chunk. It can't show support or non-support.
- Across the comparison and runs 3–4, it dropped claims whose wording continued into the next chunk:
  - 5 nucleus claims;
  - temperature claims whose sentence ends at 2:56.
- Asking the model to cite continuation chunks (`tutor-v3`) did not change that.

### 4. Connective statements are unchecked

- Connectives and analogies carry no citation, and nothing checks them.
- Run 4 has two that state facts:
  - "…very high temperature values reduce reliability of generated text";
  - "…trade off creativity/diversity versus focus/determinism".

## Decisions (for approval)

1. **Race fixes, in their own commits, each with a deterministic regression.**
   - **Fix 1: attempts (PR-4 defect).**
     - When the instance already has an attempt, look the key up again before rejecting. The re-lookup's snapshot is newer than the instance check's, so a same-key duplicate is always visible.
     - A same key with a different body still gets `idempotency_key_reused`; a different key still gets `already_submitted`.
   - **Fix 2: tutor tx1 (PR-6).**
     - When a help event exists for the key, re-check `tutor_request` before returning `idempotency_key_reused`. tx2 writes both rows atomically, so the re-check sees the tutor request.
   - **Regression tests** use a new test-only helper, `lib/db/test-interleave.ts`. It wraps `db.begin` so a transaction pauses after the first query whose SQL contains a given fragment, runs another request to completion, then resumes. This reproduces the race on every run, with no timing loops.
     - The existing concurrency test stays as it is. It is not skipped, and I will not rerun it until it passes.
   - **Where fix 1 lands** is your call (question 2).
2. **Sentence-complete evidence (a test, adopted only if the targeted checks pass).**
   - **Passages.** The server groups retrieved chunks into passages: runs of time-adjacent chunks from the same video.
     - A run is split into passages of at most 3 chunks, cutting after a chunk that ends a sentence (`.`, `?` or `!`) where the transcript has punctuation.
     - Runs from unpunctuated transcripts are split every 3 chunks; the sampling lesson's captions have no punctuation. There, "sentence-complete" is an approximation: a 2-chunk sentence is covered unless it spans a passage boundary.
   - **Citations (question 3, recommended A).** The model cites passage ids, at most 2 per claim.
     - The server expands each cited passage into citations for **every member chunk**, each with its own id, revision, timestamp and link. Source IDs are kept at chunk level.
     - A claim can therefore cite up to 6 chunks. The tutor-only cap rises from 4 to 6 (`MAX_TUTOR_CITATIONS`), which is a response-contract change. The shared `MAX_EVIDENCE_PER_STATEMENT` is unchanged.
   - **Gates** compare the claim with the text of all chunks in its cited passages. Gate 2b becomes: "wording in an uncited *passage*".
   - **Prompt version:** `tutor-v4`.
   - **Adoption rule (fixed now):** adopt if, on the targeted checks, three things hold:
     - (a) the offline replay recovers most continuation drops;
     - (b) the passage-level version of the nucleus regression still rejects wording from a different passage;
     - (c) the live targeted cases show no new claim my reading marks as unsupported.
   - Otherwise revert to chunk citations and report.
3. **Heuristic framing.** Gate 2b is called a heuristic in the code, the packet and the PR, and never proof.
4. **Connective check, in the same support call (`tutor-support-v2`; no extra call).**
   - Each connective, but not the level-1 guiding question, becomes an item checked against the union of the answer's cited chunks. It is `supported` only if it asserts no fact, or only facts stated there; otherwise it is dropped (`not_supported`).
   - Analogies are unchanged. None appeared in any run.
5. **Transcripts.**
   - **Fixtures.** Replace the verbatim fixture and test chunks with **synthetic** text written for the tests. It keeps the structure that matters:
     - a sampling-style lesson with "Pros and Cons" and "Top-p" chapters;
     - unpunctuated chunks that cut sentences;
     - a "wording in the adjacent chunk" nucleus analogue;
     - a top-k-cons chunk sharing "balance / diversity / coherence".
     Every regression stays, on the synthetic text. Test names lose their quoted phrases.
   - **Eval logs** (runs 1–4 and comparison-raw). Excerpt text is replaced by `[excerpt removed]` plus the timestamp. A header says so, and statements, statuses, citations and timings are unchanged. From now on, the eval prints timestamps only; `--excerpts` shows excerpts locally.
   - **Review packet:** see question 4.
   - **History:** no rewrite now. I will report the exact commits for your decision.
6. **Targeted checks, in order. No full live evaluation.**
   1. Unit and database tests (Node 22, local Postgres on port 54329), typecheck, lint and build.
   2. **Offline replay.** Re-validate every stored claim from the comparison and runs 3–4 (Sanity read-only, no model) under passage grouping. Count recovered drops and any new acceptances.
   3. **Live targeted cases**, 1 run each, about 9 `gpt-5-mini` calls: `elsewhere-nucleus`, `local-temperature` and `wrong-citation-downsides`.
   4. `tutor-support-v2` on run 4's two factual connectives: 2 calls, reusing the stored answers.
7. **Updated review packet.**
   - Rebuilt from run 4's stored results, with the heuristic labels, the connective verdicts, and the policy from question 4.
   - The targeted live cases are appended as a clearly labelled second section.
   - All cases stay `reviewed: false`.

## Expected files

- **Fix 1:** `lib/learner/attempts.ts`, `lib/learner/attempts.db.test.ts`, and the new `lib/db/test-interleave.ts`.
- **Fix 2:** `lib/tutor/service.ts` and `lib/tutor/tutor.db.test.ts`.
- **Evidence:**
  - `lib/ai/tutor.ts` (passages, `tutor-v4`);
  - `lib/ai/tutor-support.ts` (`v2`, connectives);
  - `lib/learner/contracts.ts` (`MAX_TUTOR_CITATIONS`);
  - the tests.
- **Transcripts:**
  - `lib/tutor/test-source.ts`, `lib/ai/tutor.test.ts`, `lib/tutor/retrieve.test.ts`, `lib/tutor/eval-check.test.ts`;
  - `docs/evals/*`, `scripts/eval-tutor.mts`, and `.gitignore` if option A of question 4 is chosen.
- **Docs:** the PR body, and these notes.

## Checks

- Typecheck, lint, `npm test` and build. Test results are reported as counts.
- The targeted checks above, reported as they come out.
- The local Postgres stays running.

## Implementation notes (2026-09-13)

- **Fix 1 (PR-4)** landed as `9827b74` on `feat/pr-4-learner-evidence`, then merged up: `63163eb` on PR-5 and `965c3fd` on PR-6.
  - **Conflict.** `lib/learner/attempts.ts` contains a literal NUL byte inside a `join('\x00')` in the PR-4 code, so git treats it as binary. The PR-5 merge therefore conflicted, and I resolved it by applying the same one-line change to PR-5's version, byte for byte.
  - **Results:**
    - PR-4 passes 361/361.
    - The PR-5 merge commit passes 398/398, run in a clean detached worktree because the PR-5 worktree holds someone's uncommitted edits to `lib/assessments/hints.ts`, `lib/learner/help.ts` and `lib/learner/help.db.test.ts`. I left those untouched and did not commit them.
    - The deterministic regression failed 3/3 before the fix and passes 3/3 after.
    - The original concurrency test, 10 runs each on this machine: 3/10 failed without the fix, 0/10 with it.
- **Fix 2 (`7dedef6`).** tx1 now looks up the help event first and the tutor request last, instead of adding a re-check. tx2 commits both rows together, so if a help event is visible, the tutor request is too.
- **Transcripts:**
  - Fixtures and gate tests use synthetic text with the same chunk times, chapter labels and sentence cuts.
  - The eval logs and the old packet are redacted (`0ebd02b`).
  - What remains in committed files:
    - the tutor's own answer statements in the logs, which sometimes reuse short lesson phrases of 6–8 words;
    - the new packet's excerpts, which cover 324 of the lesson's 1,237 words (26%). The pushed packet at `604ea16` covered 602 (49%).
  - **History:** the full text is still in pushed commits on `feat/pr-6-tutor-endpoint` only:
    - `8a5e148` (fixture) and `2a2666d` (gate tests);
    - `604ea16` (packet and logs);
    - `3a60177`/`b5e8899` and `4a48f3e`/`604ea16` (log excerpts).
  - Nothing has been rewritten.
- **Passages (`201ccba`): adopted.**
  - **Offline replay** (stored claims from the comparison and runs 3–4, no model):
    - of 13 `uncited_source` drops, 9 are citable with the one passage holding their wording, and 13 with two passages;
    - of 100 kept claims, 1 becomes a drop. It credits "flattens" to the 3:13 example, where the lesson doesn't say it.
  - **Targeted live** (3 cases):
    - all structural checks were met;
    - the nucleus answer kept 4 claims, all cited to 4:26–5:04 (before: 1–3), and two of them add a small uncited "rather than a fixed K/size" contrast;
    - temperature and downsides claims are stated in their cited passages (the author's reading), with downsides citing 5:41–5:59 as one sentence.
  - **Design choices:**
    - level-1 pointers keep chunk refs;
    - passage ids are local to a request, and an unknown one is `unknown_or_stale_ref`;
    - dropping a connective leaves the status alone.
- **Connectives:** `tutor-support-v2` passed both factual connectives from run 4.
  - On my reading, "…reduce reliability…" is a fair paraphrase of 5:59.
  - "…trade off creativity/diversity versus focus/determinism…" generalizes something the lesson states only at 7:34, which the answer does not cite.
  - So the connective check is also fallible.
- **Latency** (targeted, `tutor-v4`): total 13.3–16.2 s, answer 5.5–7.1 s, support 4.6–8.0 s. The prompts are larger now: passages repeat no text, but the support input includes `answerSources`.
