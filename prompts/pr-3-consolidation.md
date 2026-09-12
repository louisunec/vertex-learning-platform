# PR-3 follow-up: extraction v2, course-level consolidation, versioned suppression

> Superseded in part by `prompts/pr-3-equivalence-merges.md`: merges are now limited to semantically equivalent concepts (`facets` is removed), and rejecting an applied merge restores its members.

## Goal

The full-course dry run (`prompts/pr-3-concept-audit.md`) produced 88 fine-grained drafts. Lexical matching missed obvious duplicates:
- 4+ CSRF drafts;
- 2 "Authorization" drafts.

This follow-up has five parts:
- extraction v2 (primary-first, skills not facts);
- a bounded semantic duplicate-proposal step that editors confirm in the Studio;
- rejection suppression scoped to exact source and generation versions;
- a canary and a full-course dry-run report;
- a fixed-input check that the known duplicates are proposed.

Out of scope for this session:
- commits, pushes, deploys, production writes and publishing;
- raising the 60-concept prerequisite bound;
- touching `app/` or `components/`.

## Guidance read

- `AGENTS.md` §2, §9 (ranking stays server-side), §10 (inline rules, no embeddings), §12, §13.
- `prompts/pr-3-concepts.md` and `prompts/pr-3-concept-audit.md`; `prompts/pr-1-quality-followup.md` (the pattern for a follow-up prompt).

## Code inspected

- `lib/concepts/{extract,cluster,prerequisites,pipeline,graph,resolve}.ts` and their tests.
- `scripts/generate-concepts.mts`.
- Studio:
  - `schemaTypes/documents/{concept,concept-prerequisite,concept-generation-record}.ts`
  - `sanity.config.ts`, `structure.ts`
- Scratchpad data: the v1 `concepts.json` (88 drafts, 63 records). It holds 7 CSRF drafts and 2 Authorization drafts, so it is the fixed input for item 6.

## Calibration (run before writing this, with no model call)

The deterministic filters were applied to the 88 v1 names and 224 aliases:
- **Incidental-detail filter on names:** rejects 3 names:
  - `CSP 'none' source expression` (literal)
  - `Supplying secrets with terraform.tfvars…` (filename)
  - `TF_VAR environment variables` (identifier)

  All three are one-off details. There are no false positives on names such as OAuth 2.0 or HTTP headers.
- **Alias filter:** drops 10 of 224. The drops are comparisons ("Sessions vs JWTs"), parenthetical phrases, and phrases over 5 words.
  - A "broader alias" rule was tried and discarded: it dropped 46 aliases, most of them legitimate synonyms such as "Prepared statements".
  - The alias restriction therefore rests mainly on the prompt, with the filter as a backstop.

## Decisions

### 1. Extraction v2

- **Versions:** `CONCEPT_EXTRACTION_PROMPT_VERSION = 'concept-extraction-v2'`, `CONCEPT_EXTRACTION_CONFIG_VERSION = 'spans-12-primary-1-secondary-1-v2'`. All v1 records stop being current, so every span is extracted again.
- **Output shape:** `{primary: concept | null, secondary: concept | null, excludedDetails: string[], skipReason}`.
  - The shape itself enforces "one primary, at most one secondary".
  - `secondary` requires an `independenceReason` (≤200 characters) saying why it is independently teachable and testable.
  - `excludedDetails` (≤6, each ≤120) lists the facts, examples, usernames, command output or implementation details the model saw and did not turn into concepts. It is recorded, and it gives the model-side "facts/details excluded" count.
- **Prompt rules (inline):**
  - A concept is a teachable, testable skill or durable knowledge, never an incidental fact.
  - Examples, usernames, command output, specific values and one-off implementation details are not concepts.
  - Each span normally yields exactly one primary concept. Add a secondary only when it is independently teachable and testable.
  - The name has no parentheses; an abbreviation goes in `aliases`.
  - Aliases are only abbreviations, spelling variants and established synonyms. Never a broader or narrower concept, a comparison or a description.
- **Deterministic backstops:**
  - `incidental_detail:<match>`: the name contains a code literal (`= $ \` { } < > @ "` or a quoted token), a CLI flag, a snake_case or SCREAMING_CASE identifier, a filename with a code or config extension, a path, or a camelCase identifier.
  - `secondary_without_primary` and `secondary_duplicates_primary` (same match key).
  - Alias drops: comparisons (`vs`, `versus`, `compared`), parentheticals, more than 5 words, or the name plus 2 or more qualifier words. Abbreviations and spelling variants are always kept. The name is compared without a trailing parenthetical. Dropped aliases are counted on the record.
- **Retained for audit:** records now keep rejected candidates as `rejectedCandidates[] {candidateId, name, role, reason, fingerprint}`, not only the reason codes.

### 2. Stable candidate identity

Each validated candidate stores three identity fields:
- `candidateId` (its `_key`) = `cand-<sha16(extractionKey, role)>`. It is stable while the record is current.
- `fingerprint` = sha of the name's match key plus the sorted cited chunk **ids**. The summary is deliberately excluded, so a reworded summary is still the same candidate.
- `role`.

Concept drafts gain these `generation` fields:
- `candidateIds` (every candidate in the cluster);
- `role`: `primary` when any member is primary, otherwise `secondary`;
- `suppressionKey` (Decision 5).

### 3. Course-level semantic consolidation: new `consolidate` subcommand

- **Model call.** One bounded call per course over its non-rejected, non-tombstone concepts.
  - The call is refused above **120 concepts**, never truncated. 120 is at least 88, so the v1 set fits.
  - Input per concept: an index label `k<i>`, name, aliases, summary, and 1 evidence chunk (≤300 characters). That comes to about 25,000 tokens at most.
  - Versions: `CONSOLIDATION_PROMPT_VERSION = 'concept-consolidation-v1'`, config `concepts-120-evidence-1-groups-40-v1`, `gpt-5-mini`, reasoning effort medium, 180 s, 16,000 output tokens.
- **Output.** At most 40 groups, each `{members: k-indices (2–6), canonical, kind: duplicate | facets, rationale ≤300, evidence: 1–3 labels from members}`.
- **Prompt rules:**
  - Group only the same concept under different names (`duplicate`), or narrow facets that should be taught and tested as one concept (`facets`).
  - An attack and its mitigation stay separate. A prerequisite is not a merge. Related concepts that are each independently testable stay separate.
  - **No numeric target is given**, so the model does not merge to hit a quota.
- **Server validation.** It rejects:
  - out-of-range indices;
  - a group of fewer than 2 members;
  - a canonical that is not a member;
  - evidence from a non-member;
  - a concept already used in an earlier group (`overlapping_group`).
- **Proposal documents.** A proposal stores its members by **candidate ids**, plus a snapshot of each member's `conceptId` and name.
  - Proposals are written as `conceptMergeProposal` drafts with `status: proposed`. Studio references to the member concepts are weak (`_weak: true`), because the members are draft-only.
  - Each proposal records its rationale, its evidence chunk refs (mapped server-side from labels), `kind`, and generation versions and keys.
  - Nothing is merged or published by this step.
- **New Studio type `conceptMergeProposal`.**
  - Generator-only. No publish, duplicate, delete or unpublish action: the status on the draft *is* the human confirmation (`proposed | accepted | rejected`, plus a reviewer note).
  - It gets a Studio list: "Merge proposals".
- **Estimated consolidated count** = concepts − Σ(group size − 1), reported.

### 4. What acceptance does — please confirm this specifically

Concept `sourceRefs` are read-only in the Studio, so an editor cannot merge two drafts by hand, and an accepted proposal that did nothing would lose the non-canonical lessons' evidence. Proposal: the `extract` projection reads **accepted** proposals (raw perspective) and applies them to drafts.

- **Joining clusters.** Clusters containing any member's candidate ids are joined under the canonical member's concept.
  - `duplicate` groups fold the member names into aliases. `facets` groups do not.
  - Objectives and refs are unioned within the existing caps.
- **Non-canonical drafts.** Unpublished, unedited generator drafts of non-canonical members are deleted in the same transaction as the canonical draft. That deletion is confirmed by a human, not automatic. Edited drafts are left alone and reported.
- **Published members.** A group with any published member is never applied automatically. It is reported for the manual tombstone merge.
- **Stale proposals.** If a proposal's candidate ids no longer exist, because the source or versions changed, it is reported as stale and ignored.

The same projection function, with **every** proposal hypothetically accepted, produces `consolidatedDrafts` for dry-run audits, clearly labelled as hypothetical.

### 5. Versioned rejection suppression (replaces "never proposed again")

**Suppression keys:**
- concept: sha(sorted member candidate fingerprints, sorted cited `chunkId@chunkRevision`, prompt version, config version);
- edge: sha(pair, both concepts' `contentHash` — which covers their source revisions —, prompt version, config version);
- merge proposal: sha(sorted member candidate ids, prompt version, config version).

**Rules:**
- Rejected, with the same key: suppressed and reported.
- Rejected, with a different key: **reconsidered as a new document**. The rejected document is never touched, which keeps it for audit.
  - A reconsidered concept gets a new id through the collision suffix, `status: needs_review`, and `generation.reconsiders: <rejected conceptId>`.
  - A reconsidered edge gets `concept-prereq-<sha16(pair)>-<sha8(suppressionKey)>` and `reconsiders: [ids]`. The pair's first edge keeps the base id.
  - A proposal's id already derives from its key, so a reconsidered proposal gets a new id naturally.
- `split` and `archived` concepts stay terminal. A cluster matching one is reported and not proposed.
- When a cluster matches a rejected concept and a non-rejected concept, it uses the non-rejected one.
- Rejected items can never reach the published graph automatically:
  - the publish gates already block `rejected`;
  - reconsidered items start at `needs_review`;
  - consolidation input excludes rejected concepts;
  - edges are proposed among published, approved concepts only.

### 6. Dry-run plumbing

- `extract --out` adds the current `RecordedSpan[]` (`spans`) used by the projection.
- `consolidate --dry-run --concepts-from <extract out>` writes `proposals` and `consolidatedDrafts`.
- `prerequisites --dry-run --concepts-from` accepts an `extract` or `consolidate` file. From a `consolidate` file it uses `consolidatedDrafts`.
- `consolidate --concepts-from` also reads the **v1** file leniently (no `candidateIds` or roles), for the item-6 check only.

### 7. Reporting

- The `extract` report adds:
  - candidates by role, and concepts that are primary vs secondary-only;
  - model-excluded details, and deterministic `incidental_detail` rejections;
  - dropped aliases;
  - lexical duplicate groups (clusters with more than one candidate).
- A deterministic **10-concept sample** (seeded by `conceptId` hash, not hand-picked), each with its summary and `sourceExcerpt` evidence, goes into the audit note.

## Expected files

- Modified:
  - `lib/concepts/{extract,cluster,prerequisites,pipeline}.ts` and tests;
  - `scripts/generate-concepts.mts`;
  - Studio: `concept-generation-record.ts`, `concept.ts`, `concept-prerequisite.ts` (generation fields only), `schemaTypes/index.ts`, `sanity.config.ts`, `structure.ts`;
  - `sanity.types.ts`, `docs/DATA_MODEL.md` §16, `prompts/pr-3-concept-audit.md`.
- New:
  - `lib/concepts/consolidate.ts` and `.test.ts`;
  - `studio/schemaTypes/documents/concept-merge-proposal.ts`.
- **Tests rewritten, not only added.** "never proposes a rejected concept again" and "never re-proposes a rejected pair" encode the old rule. They become same-key-suppressed / different-key-reconsidered tests that also assert the rejected document is untouched.

## Acceptance criteria

1. **Unit tests** cover:
   - extraction: v2 schema bounds; primary/secondary rules; the incidental-detail and alias filters, with fixtures from the calibration names; candidate id and fingerprint stability;
   - consolidation: validation (indices, canonical, overlap, evidence); proposal ids; accepted-merge projection (duplicate vs facets aliases, non-canonical deletion, edited draft left alone, published member not applied, stale proposal ignored);
   - suppression: same key vs different key for concepts, edges and proposals;
   - the hypothetical consolidated set.
2. **Item 6 (fixed input: the v1 88 drafts), one live consolidation dry run.** It passes if:
   - the three CSRF-risk drafts share a group (`…csrf-risk-for`, `…csrf-risk-with-session-based-auth-and`, `…automatic-cookie-sending-enabling-csrf`);
   - the two CSRF-token drafts share a group (`…csrf-token-synchronizer-token`, `…csrf-token-storage-and-generation`), which together covers at least 4 CSRF drafts;
   - `cpt-authorization-access-control` and `cpt-authorization-roles-and-permissions` share a group;
   - `cors-is-not-a-csrf-mitigation` may stay separate.

   Output is not deterministic. I report the run as it happens; a second run for stability is reported alongside it, never retried until it passes.
3. **Dry runs**, all writing nothing, then the same steps on the full course:
   1. canary `extract --limit 2`;
   2. `consolidate`;
   3. `prerequisites` over the consolidated set.

   The report covers every metric in the request. Prerequisites run only if the estimated consolidated set is ≤60; otherwise the refusal is reported. The 60 bound is unchanged.
4. **All automated checks.**

## Checks

- Web (Node 22): `npm run typecheck`, `npm run lint`, `npm test`, `npm run typegen`, `npm run build`.
- Studio: `npm --prefix studio run typecheck`, `npm --prefix studio run schema:validate`.

## Security and constraints

- Nothing changes in the request path.
- Every run is `--dry-run`, and `SANITY_API_WRITE_TOKEN` is unset.
- Model input stays bounded: one span per extraction call; names, summaries and one chunk per concept for consolidation.
- Transcript and concept text are untrusted, and the inline rules say so. Model indices and labels are mapped through server allowlists.
- No deploy, no commit or push, no publishing. The `app/` and `components/` changes are untouched.

## Risks

- The model may still over-merge or under-merge. Proposals are advisory, and editors confirm each one.
- 40–60 concepts is a target, not a guarantee. If the estimate falls outside it, I report that rather than tuning the prompt to a number.
- Deleting non-canonical drafts after acceptance (Decision 4) removes unpublished drafts. Their evidence moves to the canonical, and the proposal records the history.

## Implementation notes

- **Added during implementation:** a trailing abbreviation in a name moves into the aliases (`splitTrailingAbbreviation`: "Cross-site scripting (XSS)" becomes the name "Cross-site scripting" with the alias "XSS"). This applies the prompt's no-parentheses name rule deterministically. Other parentheticals are left alone.
- **Merge validation.** A merge group with any out-of-range index is rejected whole, as approved. In the full run, 3 plausible groups were lost this way (`prompts/pr-3-concept-audit.md`, v2 section).
- **Results.** Every dry-run result is in `prompts/pr-3-concept-audit.md`, v2 section.
