# PR-3 final correction: equivalence-only merges, non-destructive rejection, Studio smoke test

## Goal

Finish PR-3 with one focused correction. There is no new full-course extraction run.
- Keep the existing 55-concept v2 extraction (records in the scratchpad `v2-full.json`).
- Merge proposals are limited to semantically equivalent concepts.
- Rejecting a merge proposal preserves every original concept.
- Prerequisites are regenerated over the 55 unmerged concepts and stay pending.
- `script-src` is no longer an alias of CSP.
- The Studio review flow is verified on a throwaway dataset.
- Then commit PR-3 files only, with no push, deploy or publish.

## Guidance read

- `AGENTS.md` §2, §10, §12, §13; `CLAUDE.md` approval gate.
- `prompts/pr-3-consolidation.md` and `prompts/pr-3-concept-audit.md` (v2 section).

## Code inspected

- `lib/concepts/consolidate.ts`, `cluster.ts` (`planConcepts`, `aliasesOf`, `matchOf`), `extract.ts` (`filterAliases`), and `pipeline.ts`.
- `scripts/generate-concepts.mts` and `scripts/sanity-http.mts`.
- Studio: `concept-merge-proposal.ts`, `sanity.config.ts`, `structure.ts` and `actions/concept-publish.ts`.
- Environment:
  - the Sanity CLI is logged in as a project administrator;
  - the only dataset is `production`;
  - CORS already allows `http://localhost:3333`;
  - Chrome is installed, but Playwright is not.

## Bug found while inspecting (item 3)

Today, a merge proposal that is accepted, applied and then rejected corrupts the canonical concept and loses the member concept:
1. When the merge is applied, the canonical draft takes the absorbed members' names as aliases, and the unedited member drafts are deleted.
2. After the rejection, the next `extract` projects the member's cluster on its own. `matchOf` resolves it to the canonical concept id through those aliases.
3. Two units then write `drafts.concept-<canonical>`. The member's projection overwrites the canonical, and the member concept is never recreated.

## Decisions

### 1. Equivalence-only merges (item 2)

- **Version bump:** `CONSOLIDATION_PROMPT_VERSION` becomes `concept-consolidation-v2`, because the output schema changes. The config version is unchanged; no cap changes.
- **`kind` removed.** `duplicate | facets` is removed everywhere:
  - model output schema, proposal draft schema, `proposalContentHash`, `ExistingProposal`, `AcceptedMerge`;
  - the Studio field and the script output;
  - the `facets` alias branch in `cluster.ts`. An accepted merge always folds member names into aliases.
  - No migration is needed: no proposal was ever written to any dataset.
- **Server enforcement.** Each group carries a `relation` the model must choose: `same_concept | subtopic | related | attack_and_defence`.
  - The server rejects every value except `same_concept`, with the code `not_equivalent:<relation>`.
  - The field is validation-only. It is never persisted, since only `same_concept` groups are written, and it is not a concept taxonomy.
- **Prompt rules (inline).** A group is allowed only when every member is the same concept under another name: mastering one means mastering the others. A group is never allowed for:
  - a sub-topic, type, property or component of another concept (such as a policy's directive or a header's value);
  - related concepts;
  - an attack and its defence;
  - a prerequisite and its dependent;
  - two techniques for the same goal.

  If unsure, the model does not group.
- **Effect on the last run.** The 5 `facets` proposals from the last run are what this change rejects.

### 2. Rejecting a merge preserves every original concept (item 3)

- **Never-applied proposal.** Rejecting it has no effect on concepts. A test asserts the plan is identical with and without the rejected proposal, with 0 deletes and 0 rewrites.
- **Applied, then rejected.**
  - `extract` also reads **rejected** proposals, and `fetchExistingConcepts` adds `generation.appliedMerges`.
  - Suppose a non-canonical cluster matches a draft whose `appliedMerges` contains that rejected proposal. Its candidate ids identify it in the proposal's member snapshot, and it is restored under the member's original `conceptId`.
  - The canonical is re-projected from its own candidates only.
  - Unedited restored members come back with identical content, because they come from the same records.
  - If the member id has since been taken by another concept, a new id is assigned and reported.
- **Generic guard.** If two units resolve to the same concept id, the result is a `conflict` and nothing is written for that id. No draft can overwrite another.
- **Studio.** Rejection stays a plain status change on the proposal draft. The Studio has no action that deletes or edits concepts.

### 3. `script-src` is a related directive, not an alias (item 5)

- **Alias filter.** `filterAliases` gains one rule: a single lowercase hyphenated token that shares no word with the concept name is a component identifier (a directive, header value or config key), not a synonym.
- **Projection.** `aliasesOf` now applies `filterAliases` against the final concept name. This also covers other members' names that were folded into aliases.
- **Calibration** (no model call). Over the 55 v2 drafts, it drops 6 of 98 aliases:
  - `script-src`
  - `Content Security Policy script-src`
  - `strict-origin-when-cross-origin` (on Referrer-Policy)
  - `OAuth 2.0 access and refresh tokens`
  - `Software composition analysis (SCA) tools`
  - `One-way password hashing` (a mild loss)
- **Where the directive lives now.** It stays in CSP's evidence and objectives. No new field is added.
- **No extraction version bump.** A bump would make every record stale and force a full rerun.
- **Clustering is unchanged.** A re-projection with 0 model calls proves the 55 concept ids are unchanged.

### 4. Prerequisites over the 55 unmerged concepts (item 4)

- One dry-run call: `prerequisites --dry-run --concepts-from <the re-projected extract file>`.
- The report covers:
  - the number of edges;
  - rejections;
  - cycles;
  - the doubtful edges, with reasons.
- Nothing is written. Every edge would be a `proposed` draft pending review.

### 5. Studio smoke test on a throwaway dataset (item 6)

1. **Create the dataset.** `sanity dataset create pr3-smoke --visibility private`, using the CLI user session.
2. **Seed content.**
   - Export production (a read only) with `--types course,lesson,video,instructor,category,sanity.imageAsset`, and import it into `pr3-smoke`.
   - Import the 63 v2 extraction records from `v2-full.json`.
   - Add one sentinel document, `smoke.sentinel`, that exists only in `pr3-smoke`.
3. **Write safety.**
   - Writes use the CLI session token, which also reaches production.
   - Every write command sets `NEXT_PUBLIC_SANITY_DATASET=pr3-smoke` in the process environment; Node's `--env-file` does not override it.
   - Every write command runs only after a preflight read finds the sentinel through the same environment.
   - Nothing is written to production.
4. **`extract`** runs non-dry-run against `pr3-smoke`. Expected: 0 model calls and 55 drafts. This also verifies Decision 3.
5. **`consolidate`** runs non-dry-run against `pr3-smoke`: one model call. It gives the corrected proposal set for the report. If it proposes 0 groups, I seed one clearly labelled fixture proposal (the "password salting" / "password hashing and salting" pair) so the flow can be exercised.
6. **Studio.** Run `SANITY_STUDIO_DATASET=pr3-smoke npm --prefix studio run dev` locally. Nothing is deployed.
   - **Normal authentication:** you sign in once, in an isolated Chrome profile with default security flags.
   - I then drive the checks through Chrome's debugging port, with `playwright-core` installed in the scratchpad, not the project, and take screenshots.
   - If you prefer, you work through the same checklist by hand instead.
   - **The commit waits on this step.**
7. **Checklist.**
   1. The Studio shows 55 concepts. Production has 0, which proves the dataset.
   2. Publishing a `needs_review` concept is blocked with the gate message. Publishing succeeds after Approved plus every check.
   3. Concepts have no delete, unpublish or duplicate action.
   4. Merge proposals have no publish, delete, duplicate or unpublish action.
   5. Reject a proposal, then run `extract`. All 55 concepts are unchanged, with 0 deletes.
   6. Accept a proposal, then run `extract`. The merge is applied.
   7. Set that proposal to rejected, then run `extract`. The original concepts are restored at their original ids.
8. **Cleanup.** Delete `pr3-smoke` afterwards and close the dev server and Chrome profile.

## Expected files

- **Modified:**
  - `lib/concepts/{consolidate,cluster,extract,pipeline}.ts` and their tests;
  - `scripts/generate-concepts.mts`;
  - `studio/schemaTypes/documents/concept-merge-proposal.ts`;
  - `sanity.types.ts` (typegen);
  - `docs/DATA_MODEL.md` §16;
  - `prompts/pr-3-consolidation.md` (a pointer) and `prompts/pr-3-concept-audit.md` (a new section).
- **New:** this file.

## Acceptance criteria

1. **Unit tests** cover:
   - `not_equivalent:*` rejections;
   - no `kind` anywhere;
   - a rejected, never-applied proposal leaves the plan identical;
   - accept → apply → reject → re-project restores every original id, with 0 conflicts and 0 deletes;
   - two units on one id give a conflict with nothing written;
   - the component-identifier alias rule and projection-level alias filtering.
2. **Re-projection:** 55 concepts with the same ids, and CSP without `script-src`.
3. **Prerequisites dry run** over the 55 concepts is reported, with every edge pending.
4. **The Studio checklist** passes on `pr3-smoke`.
5. **Automated checks:**
   - Web: `typecheck`, `lint`, `test`, `typegen`, `build`;
   - Studio: `typecheck`, `schema:validate`.

## Commit

- Stage explicit PR-3 paths only, never `git add -A`.
- Before staging, check that `docs/DATA_MODEL.md`, `package.json` and `sanity.types.ts` carry no PR-2 content.
- Exclude:
  - `docs/Vertex_AI_Native_Development_Plan.md`
  - `prompts/jsmastery-dark-theme.md`
  - `app/`
  - `components/`
- Leave `stash@{0}` alone.
- Do not push, deploy or publish.

## Model calls

At most 2, both small:
- `consolidate` over 55 concepts;
- `prerequisites` over 55 concepts.

The re-projection and the smoke-test `extract` runs make 0 calls.

## Risks

- The model may still label a sub-topic as `same_concept`. Editors still decide every proposal.
- The browser step needs you to sign in.

## Implementation notes

- **Restore also covers "proposed".** A proposal that is set back to `proposed` after it was applied is undone like a rejection, because the Studio status radio allows it.
- **Extra Studio fix, approved separately during the smoke test.**
  - Removed "Schedule publish" from publish-gated types (including assessments) and from proposals.
  - Removed "Discard changes" from proposals.
  - Disabled "Discard changes" on never-published concepts and edges (`keepUnpublishedDrafts`).
- **Studio port.** The old `sanity dev` on port 3333 was stopped at the user's choice.
- **Results.** They are in `prompts/pr-3-concept-audit.md`, in the "Final correction" section.
