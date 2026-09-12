# PR-3 final verification, boundary documentation, push and PR

## Goal

This round is targeted verification only. Afterwards: a follow-up commit on top of `2b09e7a` (never amended), a push, a PR against `feat/pr-1-reviewed-assessments`, and an isolated worktree for PR-4.

There is no deploy, no merge and no production write.

## Facts checked (read only)

- **Production** has 0 assessments, 0 concepts and 0 generation records. The assessment smoke test therefore needs generated assessments in a test dataset.
- **Learner assessment reads** (`LESSON_PRACTICE_ITEMS_QUERY` plus `toLearnerAssessments`) already require:
  - the published perspective;
  - `reviewStatus == "approved"` and `sourceStatus == "current"`;
  - no `drafts.` or `versions.` ids;
  - the highest version per family;
  - a strict learner schema.

  `lib/assessments/learner-query.test.ts` covers these rules.
- **Concepts** have no learner read in PR-3: no route, page or `sanity/queries` file reads concepts or edges. The rule for readers lives in two places:
  - `lib/concepts/graph.ts`: the active graph is published `approved` edges between published `approved` concepts;
  - `lib/concepts/resolve.ts`: anything not approved resolves to `unavailable`.
- **GitHub:** `gh` is at `/opt/homebrew/bin/gh` and logged in as `louisunec`. PR-1 is #7 (`feat/pr-1-reviewed-assessments`, open). The remote PR-1 head is `b4a0b89`, the base of `2b09e7a`.

## Steps

1. **Test dataset `pr3-verify`.** Private. Created and seeded like `pr3-smoke`:
   - a read-only export of production content;
   - the 63 v2 extraction records;
   - a sentinel document.

   Every write goes through the fail-closed wrapper: the dataset is set in the process environment, and a sentinel preflight runs with the CLI session.
2. **Assessment actions.**
   - Generate real assessment drafts for one short lesson (`authentication-vs-authorization`, a few model calls) into `pr3-verify`.
   - In the local Studio, confirm:
     - no "Schedule publish" and no "Duplicate";
     - Publish is disabled with the gate message until Approved plus every check, then publishes;
     - "Discard changes" behaves as before (assessments are not in the audited-draft set).
3. **Prerequisite edge flow.**
   - Run `extract` (0 model calls), giving 55 drafts.
   - In the Studio, approve and publish 4 concepts: SQL injection, parameterized queries, cross-site scripting, and Content Security Policy.
   - Run `prerequisites` non-dry-run against `pr3-verify` (1 model call). It drafts `proposed` edges among those 4.
   - For one edge, check in the Studio:
     - no schedule action, and Discard disabled;
     - Publish blocked with the gate message;
     - Approved plus every check lets it publish.
   - Then run `validate:concepts` against `pr3-verify`: the graph must have 0 defects.
   - Other edges stay `proposed`.
4. **Browser.** A fresh isolated Chrome profile with default security. **You sign in once**, and I drive the checks and take screenshots.
5. **Cleanup.** Delete `pr3-verify`, stop the Studio and Chrome, and delete the profile.
6. **Docs.** `docs/DATA_MODEL.md`, a short "Authorization boundaries" subsection in §16, with a pointer from §15:
   - Studio gates are editorial workflow controls, not API authorization.
   - Learner reads must require approved, eligible, published records. The assessments query does this today, and future concept or edge readers must use the published perspective, `approved` status, `current` source, and `resolve.ts` / `graph.ts` rules.
   - Privileged API writers (write-capable tokens and CLI sessions) and Releases are separate boundaries the gates do not cover.
7. **Pending items.** The salting merge proposal and all 38 edges, the 12 doubtful ones included, exist only in dry-run output. Nothing is accepted or approved. The PR description lists them as pending review.
8. **Follow-up commit.** It holds the docs, this prompt, the audit results, and any fix found in steps 2–3. A fix gets its own note here. `2b09e7a` is preserved.
9. **Checks before the push:**
   - Web: `typecheck`, `lint`, `test`, `build`;
   - Studio: `typecheck`, `schema:validate`.
10. **Push and PR.**
    - `git push -u origin feat/pr-3-concepts`.
    - `gh pr create --base feat/pr-1-reviewed-assessments` with a "Cross-PR change" section: removing "Schedule publish" also changes PR-1's assessment actions.
11. **PR-4.**
    - `git worktree add ../vertex-pr-4 -b feat/pr-4-learner-evidence <verified PR-3 tip>`.
    - There, inspect and write `prompts/pr-4-learner-evidence.md` (plan §5 PR-4, Supabase, PostHog flags, sign-in for attempts).
    - Ask for approval before any PR-4 code.

## Model calls

- Assessments: a few calls, for one lesson.
- Prerequisites: one call, over 4 concepts.

## Risks

- Generated assessments may all be rejected by quality checks. If so, I run one more short lesson and report it.
- The prerequisite call may propose 0 edges among the 4 concepts. If so, I publish 2 more related concepts (authentication, authorization) and run it once more.

## Implementation notes

- **Fix found in step 3.** Edges still offered **Delete**, on never-published drafts as well as published edges. That conflicted with "rejected edges are kept for audit" and "retire a published edge". `conceptPrerequisite` joined `PERMANENT_TYPES`, so edges now have no delete or unpublish action. Re-checked in the Studio.
- **Studio port.** At your choice, your Studio on port 3333 (PID 36556) was stopped for the test and then restarted with `npm run studio` from this session.
- **Results.** They are in `prompts/pr-3-concept-audit.md`, in the "Final verification" section.
