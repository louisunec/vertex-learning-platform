# PR-6 follow-up 4: unsupported additions, targeted reruns, contract, NUL byte, transcript cleanup (#12)

The `tutor` flag stays off, PR #12 stays a draft, and all nine cases stay `"reviewed": false`. Broad live evaluations stay paused; only the targeted reruns in item 2 call the model. No merge into `main`, no deployment, no production migration, no force-push, no history rewrite.

> **After the history rewrite (2026-09-13):** PR-6 SHAs below are those of the rewritten branch. Where this file says a commit or file carried transcript text, it describes it before the rewrite; the rewritten commits carry the redacted versions. The old-to-new table is in the PR #12 description.

## Findings from inspection

### 1. The two unsupported statements are model output that the current gates let through

| Case (stored result) | Statement | Why it is unsupported |
| --- | --- | --- |
| `elsewhere-nucleus`, targeted run at `b5a5b3b` (claims 2 and 4) | "…determined by cumulative probability **rather than a fixed K**…" and "…**rather than a fixed size**." | Cited 4:26–5:04. The source defines top-p by a cumulative threshold and says it is more coherent "compared to top-k". It never says top-k's set is "fixed", and never contrasts the two by set size. My earlier "paraphrase" reading was wrong: this is an unsupported addition, and the adoption rule's condition (c) was **not met** at `b5a5b3b`. |
| `prompt-injection`, run 4 at `9bf8d3b` (connective) | "These behaviors let you **trade off creativity/diversity versus focus/determinism** when generating text." | It generalizes the summary at 7:16–7:34, which this answer neither cites nor retrieved: 7:16 and 7:34 are not among the case's 21 retrieved chunks, so the tutor **could not cite 7:34** here. The connective check passed it afterwards, so that check is fallible. |

- **Why gate 2b missed the first one.** Gate 2b needs an *uncited* source holding 3 or more of the claim's missing words. "fixed" occurs in no retrieved chunk, so nothing fires.
- **Other stored connective.** `wrong-citation-downsides` (run 4) also has one: "…very high temperature values **reduce reliability**…". "Reliability" is not in its sources either, so the rule below drops it too.
- **Stored results are never edited.** The JSON rows stay as recorded. The fix is in code, and the proof is regression tests plus fresh runs.

### 2. The literal NUL byte is only on the PR-4 branch

- `lib/learner/attempts.ts:94` on `feat/pr-4-learner-evidence` (`9827b74`) reads `.join('<NUL>')`, a raw 0x00 byte inside the quotes. That makes git (and GitHub, which uses the same first-8-KB rule) treat the file as binary, so PR #10's diff of the file is not viewable.
- PR-5 (`0cfb0a0`) already moved `matchesDelivery` into `lib/learner/task-instances.ts`, spelled `'\0'`. **Neither the PR-5 nor the PR-6 head has a NUL** in any tracked text file; the only other hit is `app/favicon.ico`.
- **Consequences:**
  - PR #10 shows `attempts.ts` as binary.
  - PR #11 too, because its merge-base side (`9827b74`) holds the NUL.
  - PR #12 is unaffected.
- **`'\0'` is the same one-character string**, so runtime behaviour is identical.

### 3. The PR-5 worktree's uncommitted edits were not touched by the branch movement

- The edits are in `lib/assessments/hints.ts` (adds `isHintRungLevel`), `lib/learner/help.ts` and `lib/learner/help.db.test.ts` (a new test: "never replays a key whose recorded help delivered no hint").
- **Timing.** They were saved at 14:22–14:23. My merge `63163eb` came later, at 17:00:55, and was made in that worktree.
- **The merge could not have changed them.** `0cfb0a0..63163eb` changed only `attempts.ts`, `attempts.db.test.ts` and `test-interleave.ts`, so the three edited files are byte-identical in both commits, and `git diff` shows only the author's edits.
- **No conflict with PR-6.** A dry-run three-way merge (`git merge-file`, run in the scratchpad) of each edited file against PR-6's `77d1b7a` gave 0 conflicts. PR-6's only change nearby is the `truncate` line in `help.db.test.ts`.
- **Not yet run:** the tests with the edits present (see item 5 below).

### 4. Transcript text in the current public tree, measured as words inside 8-word runs shared with any of the 120 published transcripts (244,757 words)

| File at `77d1b7a` | Words | What it is |
| --- | --- | --- |
| `docs/evals/pr-6-tutor-review-packet.md` | 737 | ≤25-word source excerpts per statement |
| `docs/evals/pr-6-tutor-comparison-raw.txt` | 199 | raw two-arm log (6,939 words): the tutor's statements |
| `docs/evals/pr-6-tutor-eval-run-{1..4}.txt`, `pr-6-tutor-run-4.json`, `pr-6-tutor-targeted-1.{json,txt}` | 24–60 each | the tutor's own statements, which reuse short lesson phrases (longest 13–15 words); the excerpts were already redacted |
| `lib/tutor/test-source.ts` | 8 | a generic outro phrase in the synthetic fixture |
| `lib/assessments/generate.test.ts` | 9 | a generic phrase from PR-1, on every stacked branch; out of scope |

- Prompts, PR bodies #10–#12, issue #13 and all PR-6 commit messages have 0 such runs.

### 5. Pushed history (for the cleanup, item 7)

- **Where the transcript text is.** Every blob carrying extensive transcript text is reachable only from `feat/pr-6-tutor-endpoint` (local and origin) and so from PR #12. It came in with 7 commits: `4ece6dd`, `1ec35d7`, `16ae07e`, `8d4a4c2`, `9bf8d3b`, `3843f17` and `22aecc4` (the last is the ≤25-word excerpts).
- **What depends on the branch.** No other branch or tag contains these commits. The repo has 0 forks. PR #12 has 0 review comments and 0 reviews, so a rewrite loses no comment threads.
- **GitHub's current guidance** ("Removing sensitive data from a repository", read 2026-09-13):
  - `refs/pull/*` are read-only, so a force-push cannot rewrite them.
  - After a rewrite, old commits stay reachable "directly via their SHA-1 hashes in cached views on GitHub" and "through any pull requests that reference them".
  - Only GitHub Support can dereference PRs, garbage-collect and remove cached views. For that they want the first changed commits and the number of affected PRs.
  - **But:** "GitHub Support won't remove non-sensitive data, and will only assist … where we determine that the risk can't be mitigated by rotating affected credentials." Third-party caption text may not qualify, so after a force-push the old commits could stay reachable by SHA indefinitely.
  - The recommended tool is `git-filter-repo` ≥ 2.47, which is not installed here; local git is 2.37.1.

## Plan

### Item 4 first: remove the NUL (PR-4 → PR-5 → PR-6)

1. **PR-4 worktree:**
   - Replace the byte with `'\0'`.
   - Commit, then run the PR-4 suite.
   - Check `git diff --numstat 9933a18 HEAD -- lib/learner/attempts.ts` shows line counts, not `-  -`.
   - Push to #10 and check GitHub via `gh api repos/{owner}/{repo}/pulls/10/files`: the `attempts.ts` entry must now have a `patch`.
2. **PR-5, in a temporary detached worktree in the scratchpad, at `origin/feat/pr-5-help-policy`:**
   - Merge PR-4. The expected modify/delete-style conflict resolves by keeping PR-5's file, so the net tree change is zero (verify that `git diff HEAD^1 HEAD` is empty).
   - Push with `git push origin HEAD:feat/pr-5-help-policy`, a fast-forward.
   - **Why not the PR-5 worktree:** its checkout, local branch ref and uncommitted files are not touched. Its local branch is simply behind origin by two commits whose tree is identical, so a later `git pull --ff-only` there changes no file.
   - Check #11's `attempts.ts` patch the same way.
3. **PR-6:** merge `origin/feat/pr-5-help-policy`. It's a no-op tree, and keeps #12 on its base. Push.

### Item 1: stop unsupported contrasts and fact-stating connectives (one commit, `tutor-v5` / `tutor-support-v3`)

- **Gate 2c, contrast (deterministic, a lexical heuristic like 2b).** For each claim, find each contrast phrase:
  - it starts at a marker: `rather than`, `instead of`, `as opposed to`, `unlike`, `compared to|with`, `versus`/`vs`;
  - it runs to the next comma, semicolon, full stop, or clause word (`and`, `while`, `so`, `because`, `but`), at most 6 words.
  - **Drop test.** If a content word of the phrase (the question's words excepted) is in none of the claim's cited passages, drop the claim with reason `unsupported_contrast`, before the support call.
  - **Matching.** Words are compared as in gate 2b (word roots). Before comparing, both sides join letter-hyphen-letter and a trailing single letter onto the previous word ("top-k", "top‑k", "top k" and "topk" all become `topk`). Otherwise the *supported* "compared to top-k sampling" (source: "compared to topk sampling") would be dropped.
  - For "rather than a fixed K" the phrase word is `fixed`, absent from 4:26–5:04, so the claim is dropped.
- **Gate 2d, connective adds content (deterministic).** Drop a connective with reason `connective_adds_content` when it has a content word that is:
  - in none of the answer's kept claims;
  - in none of their cited text;
  - not in the question;
  - not in a short discourse list (`good`, `question`, `next`, `first`, `finally`, `together`, `overall`, `summary`, `short`, `key`, `point`, `idea`, `step`, and so on).

  Only what remains goes to the model connective check. The level-1 guiding question is not a model connective and is unaffected. As before, a dropped connective does not change the status.
- **Prompt rules.**
  - Tutor, `tutor-v5`: "Do not add a comparison, contrast or reason that the cited passages do not themselves state." Also: "A connective only links your claims, using their words; any sentence that states a fact is a claim and cites the passage that states it."
  - Support check, `tutor-support-v3`: "A comparison or contrast clause is a factual part: supported only if the sources make the same comparison."
- **Synthetic fixture.** Chunk 304 now says "more coherent than top k sampling" instead of "…a fixed top k list", matching the real shape. Otherwise a regression would pass for the wrong reason.
- **Regression tests (synthetic fixtures):**
  - The contrast claim citing the 4:06–4:47 and 5:04 passages is dropped as `unsupported_contrast`, with 0 support calls.
  - The same claim without the clause is kept.
  - "…more coherent compared to top-k sampling" citing 5:04 is kept (the hyphen form).
  - The prompt-injection connective is dropped as `connective_adds_content` before the support call.
  - "Here is the next part." and a connective reusing only claim words are kept.
  - Existing tests are updated for the version strings (`tutor.db.test.ts`, prompt assertions).
- **Offline replay.** No model call. Run every stored claim and connective (runs 1–4, targeted, both comparison arms) through gates 2c and 2d, and list every statement they would newly drop. Whatever the list shows is reported, with no judgement calls hidden.

### Item 2: rerun only the affected cases, and rebuild the packet

- **Which cases.** Those whose latest stored answer changes under gates 2c and 2d in the replay, plus the two named. I expect `elsewhere-nucleus`, `prompt-injection` and `wrong-citation-downsides`: 3 cases, one run each, 6 model calls. A failure is reported, not rerun.
- **Run from a clean tree.** Each run happens at the committed code, so the recorded commit is exact.
- **`eval-tutor.mts --json` rows gain provenance.** Each gets `commit` (with a dirty flag), `promptVersion` and `supportPromptVersion`.
- **The packet shows one entry per case (all 9), each with a provenance line:**
  - **Fresh run:** `<sha>`, date, `tutor-v5` / `tutor-support-v3`.
  - **Stored result, not re-run:** the run and `<sha>`, plus the versions it used. Then "Current gates 2c/2d would also drop: …" from the offline replay, or "nothing".
  - Superseded stored answers for the rerun cases stay below in a "Superseded" part, labelled with their commit.
- **Item 6 applies here too:** the committed packet gets no source text.

### Item 3: the citation contract

- **Contract documentation:**
  - `prompts/pr-6-tutor-endpoint.md` §12: `ResolvedCitation[] ≤4` becomes `≤6` (`MAX_TUTOR_CITATIONS`: up to 2 passages of up to 3 adjacent chunks), with a dated amendment.
  - The `tutorStatementSchema` / `tutorResponseSchema` JSDoc in `lib/learner/contracts.ts` (canonical, per ARCHITECTURE §12) says the same. It also notes that the model-output cap `MAX_EVIDENCE_PER_STATEMENT = 4` (search and level-1 pointers) is unchanged.
- **PR-7 consumers.** None exists in the code today: no branch or UI reads `tutorResponseSchema` outside PR-6. The plan names PR-7's `TutorPanel` citation buttons and "citation navigation" acceptance, and PR-10 (editorial feedback) depends on PR-6. I will document the rule for them:
  - keep every citation's `chunkId` and `sourceRevision`;
  - render citations that share a `lessonId` and are contiguous (one's `endSeconds` equals the next one's `startSeconds`) as one seek range starting at the first `startSeconds`.

  Documentation only, no helper.

### Item 5: the PR-5 worktree (read-only)

- Run `npm test` in the PR-5 worktree as it is, edits included. This modifies no tracked file; `next typegen` and typecheck are skipped there.
- Run the suite once more in a temporary worktree at the new PR-6 tip, with the three merged files from the dry run, to check compatibility.
- Report counts and any conflict. Nothing is reset, stashed, overwritten or committed.

### Item 6: no extensive transcript text in the public tree (one commit)

- **Committed packet:** statements, timestamp links and verdict boxes, with no source text. The full-text copy is written only to the gitignored `docs/evals/local/`.
- **Raw logs:**
  - `docs/evals/pr-6-tutor-comparison-raw.txt` is removed from the tree, and a copy moves to `docs/evals/local/`. `pr-6-tutor-comparison.md` stays as the concise summary; its reference is updated.
  - The redacted run logs stay: what remains is the tutor's own statements, as stated in their headers.
- **Fixture:** the synthetic outro phrase is reworded.
- **Check:** rescan the new tip and report per file, using the same 8-word metric.

### Item 7: prepare the history cleanup; do not execute it

- **Setup.** A fresh `git clone` in the scratchpad, plus `git-filter-repo` v2.47.0, fetched as a single pinned script into the scratchpad and run with `python3`. Nothing is installed system-wide.
- **Rewrite** `feat/pr-6-tutor-endpoint` only, with a blob callback mapping each offending blob (the scan's list) to its already-redacted or synthetic counterpart, or to the new tip's version.
  - Commit shape and messages are kept. Intermediate commits may not build, because their tests referenced the removed text.
  - The candidate goes on a new local branch, `cleanup/pr-6-tutor-endpoint`, in the clone. It is **never pushed**.
- **Verification:**
  - The candidate tip tree equals the real tip tree.
  - Each rewritten commit differs from its original only in the mapped paths.
  - Rescanning every candidate blob shows no extensive runs.
  - The full suite passes in the clone.
  - The `commit-map` gives an old-to-new SHA table.
- **Report:**
  - **Refs that would change:**
    - `refs/heads/feat/pr-6-tutor-endpoint` on origin (force-push);
    - `refs/pull/12/head` and `/merge`, which GitHub moves; the old SHAs stay reachable until Support acts, if it does;
    - the local branch and `origin/…` in the PR-6 worktree.
  - **Not affected:** PR-4, PR-5, `main`, forks (none) and tags (none).
  - **Dependent updates:** reset the PR-6 worktree to the candidate; update the SHAs cited in the #12 body, the #10 and #11 follow-up notes, issue #13, `prompts/pr-6-*.md` and memory. A GitHub Support request would need the first changed commit (`3a60177` before the rewrite) and the number of affected PRs (1).

## Commits (ordinary pushes only)

1. PR-4: the NUL escape.
2. PR-5: the merge.
3. PR-6: the merge.
4. PR-6: gates 2c/2d, prompts and tests.
5. PR-6: packet renderer without source text, JSON provenance, raw log removed, fixture outro.
6. PR-6: fresh results and the rebuilt packet.
7. PR-6: contract docs.
8. PR-6: these notes and the PR #12 body.

## Checks

- **PR-6:** `npm run typecheck`, `npm run lint`, `npm test` (with `TEST_DATABASE_URL`), `npm run build`, and the signed-out `POST /api/tutor` → 401 check.
- **PR-4:** full suite. **PR-5:** full suite in the temporary merge worktree.
- The scans and GitHub `patch` checks above.

## Security

- No auth, route, flag or schema change.
- Model calls: 6, only in the item 2 reruns.
- The clone and filter-repo run only in the scratchpad.
- No force-push. The `tutor` flag stays off.

## Manual tests for you

1. Open PR #10's "Files changed": `lib/learner/attempts.ts` shows a text diff.
2. Open `docs/evals/pr-6-tutor-review-packet.md`: it has 9 cases, each with a provenance line, and no source quotes.
3. Run `git -C <scratchpad clone> log --oneline cleanup/pr-6-tutor-endpoint` and compare it with the SHA table in the report.

## Implementation notes (2026-09-13, approved as written; candidate shape: rewrite blobs)

- **NUL byte:**
  - `42dc10c` on PR-4 replaces the byte with `'\0'`.
  - `0e643d2` merges it into PR-5 from a temporary worktree and is pushed to origin only, so the PR-5 worktree and its local branch are untouched. The conflict resolved to PR-5's file, leaving the tree unchanged.
  - `25afd20` merges into PR-6, also with no tree change.
  - GitHub now returns a text `patch` for `attempts.ts` in #10 (238 additions) and #11 (+3/−15).
- **Gates 2c/2d, `tutor-v5` / `tutor-support-v3`** (`bac7ede`). The offline replay covered 68 stored answers, 156 kept claims and 11 model connectives:
  - 2c drops 5 claims: four "rather than a fixed K/size/count", and one run-2 trade-off whose "coherence" is not in its cited text;
  - 2d drops all 11 connectives. Each states or offers something beyond its claims.
  - Only `elsewhere-nucleus` and `prompt-injection` have a current answer that changes.
- **Packet without source text, plus provenance** (`9fd4ba9`). The raw two-arm log left the tree.
- **Fresh runs at `9fd4ba9`** (`c601875`). 4 model calls. Both runs met the structural checks with 0 drops:
  - nucleus: 2 claims, no contrast;
  - prompt-injection: 5 claims, no connective, and the injected instruction was not followed.

  Totals were 11.6 s and 15.8 s.
- **Contract docs** (`c4feb73`).
- **PR-5 worktree.** The suite passes with the author's edits present (399/399). Their files' checksums are unchanged. The three edits merge onto the PR-6 tip with 0 conflicts, and there the suite passes (494/494) and typecheck passes.
- **Tip scan** (at `eceb4f6`). No transcript quotes remain. The words inside 8-word runs are the tutor's own statements, which reuse lesson phrases of at most 13 words: 24–93 per eval file (93 in the packet, which repeats statements across Parts 1 and 2). `lib/assessments/generate.test.ts` has 9 (PR-1, out of scope).
- **Item 7** (the history-cleanup candidate) is prepared outside the tree after this commit. Its SHA table and the refs are in the PR #12 description.
- **Cleanup executed** (2026-09-13, approved). Pushed with `--force-with-lease` on the full old SHA: `feat/pr-6-tutor-endpoint` `6102d67` → `0b46655` (same tree); no other branch or tag moved. PR #12's head is `0b46655`, its base is unchanged, and it is still a draft. The old commits still resolve on GitHub by SHA, and through the PR's force-push event, until GitHub Support acts, if it does.
