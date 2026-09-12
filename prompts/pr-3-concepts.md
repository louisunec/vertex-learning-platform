# PR-3: Reviewed concepts and prerequisite relationships

## Goal

Implement the third increment of `docs/Vertex_AI_Native_Development_Plan.md` (§5 PR-3): a small, stable vocabulary of skill concepts that later evidence and recommendations can use.

- Concepts live in Sanity. They are drafted offline from bounded transcript spans and published only after an editor approves them.
- Proposed prerequisite edges are also drafts. They carry evidence, a rationale and a status, and are published only after review.
- A read-only validator checks graph integrity and assessment coverage.
- There is no learner route, UI, mastery or feature flag. Mastery belongs to PR-4 in Supabase, and navigation and recommendations belong to PR-11.

**Small pilot scope, as the plan's "a small PR-3 scope" asks:**
- one course (`practical-web-security`, 12 lessons);
- lexical concept matching;
- generator-only concepts and edges;
- no UI.

## Guidance read

- `AGENTS.md` §2, §3 (high-risk: schema), §7, §9–§12; `CLAUDE.md` approval rules.
- Development plan §3 (data ownership, versioning, inference limits), §4, §5 PR-1/PR-3/PR-4/PR-11, §6.
- `prompts/pr-1-reviewed-assessments.md` (+ follow-ups): generation keys, generation records, draft-only writes, gated publish, staleness, dry-run audit practice.
- Memory: Supabase for learner state (PR-4); the read token is Editor-grade; the agent shell needs Node 22 via nvm.

## Code inspected (on `feat/pr-3-concepts` = PR-1 tip `b4a0b89`)

- Studio:
  - `schemaTypes/{index,documents/assessment,documents/assessment-generation-record,documents/lesson}.ts`
  - `actions/assessment-publish.ts`, `structure.ts`, `sanity.config.ts`, `package.json` (the dataset is `production`)
  - `scripts/context/search-context.ndjson`
- Lib:
  - `lib/evidence/chunks.ts` (`chunkId`, `chunkRevision`, `hashParts`)
  - `lib/assessments/{spans,generate,pipeline,staleness,quality}.ts`
  - `lib/ai/{gateway,contracts}.ts`, `lib/flags.ts`
- Data and CLI: `sanity/queries/assessments.ts`, `scripts/generate-assessments.mts`, `package.json`.
- Other: the MCP `groqFilter` is a type allowlist (`course, lesson, video, instructor, category`), so the new types are excluded by construction.

## Decisions and assumptions

1. **Three new Sanity document types:**
   - `concept` (vocabulary);
   - `conceptPrerequisite` (one edge per document, with its own review lifecycle, so reviewing an edge never changes a concept's revision);
   - `conceptGenerationRecord` (operational log).

   None of them has a learner field. Learner mastery stays outside Sanity (PR-4, Supabase).
2. **Stable concept identifiers.**
   - `conceptId` is assigned once, when a concept is first drafted: `cpt-<kebab(canonical name)>`, at most 48 characters, with `-2`, `-3` … on collision with a different concept.
   - The document id is `concept-<conceptId>`.
   - The id is stored and **never recomputed**: renaming a concept keeps its id.

   **The rerun rule.** Before assigning a new id, a candidate cluster is matched against every existing concept (draft or published) by normalized name or alias:
   - one match reuses that concept's id;
   - two or more matches are reported as a conflict, and no draft is written for that cluster;
   - no match gets a new id.

   The same concept under a different model name on a `--force` rerun therefore keeps its id only when the name or an alias overlaps. Otherwise it becomes a new draft beside the old one, and the reviewer merges them (Decision 9). This is a known limit of lexical matching.
3. **Lexical matching, deliberately not embeddings.** The plan says to use embeddings for candidate matching. AGENTS.md §10 says embeddings are disabled and that enabling them is a billing decision. Matching therefore compares normalized names and aliases:
   - lowercase;
   - non-alphanumerics become spaces;
   - a trailing `s` is stripped from words of 4+ letters.

   This is not semantic matching. Its expected failure modes are missed synonyms and merged homonyms. Both are review checks (`notDuplicate`, `granularityAppropriate`).
4. **Extraction.**
   - Spans: one model call per bounded span, reusing `buildSpans` and `toSourceChunks` from PR-1, so a call never sees more than 12 chunks (about 3,600 characters) and never a whole transcript.
   - Output per call: at most 2 concept candidates, each with:
     - `name` ≤80 characters;
     - `aliases` ≤5, each ≤80;
     - `summary` ≤300;
     - `objectives` 1–3, each ≤200 and starting with a verb;
     - `sourceChunks` as span-local indices (`c0…cN`), which the server maps through the span allowlist.
   - The model never authors an id, timestamp or revision.
   - Limits are checked after generation. The provider schema has no `maxLength` (the PR-1 lesson), so over-limit or truncated text rejects the candidate. It is never truncated.
   - PR-1's `quality.ts` checks reject generator or source-pointer language.
   - Administrative spans may return zero candidates with a `skipReason`.
5. **Idempotency across course-level clustering.**
   - Every span whose call returned schema-valid output gets a `conceptGenerationRecord` (`kind: span_extraction`) **holding its validated candidates** (bounded: ≤2 candidates, ≤12 chunk refs each).
   - The record id is `concept-generation-<extractionKey>`.
   - Reruns skip recorded spans unless `--force` is passed.
   - Provider failures, timeouts, invalid output and budget deferrals leave no record and are retried.
   - Concept drafts are a **deterministic projection of all records for the course**. A rerun with unchanged inputs makes no model call and writes nothing. This is testable.
6. **Clustering (deterministic, no model call).**
   - Candidates are unioned when their normalized name or alias keys intersect.
   - The representative of each cluster is the candidate with the most supporting chunks. Ties go to lesson order, then span index.
   - Draft content:
     - `name` and `summary` come from the representative;
     - `aliases` are the union of the other names and aliases, at most 8, deduplicated and ordered deterministically;
     - `objectives` are the deduplicated union, at most 4, with the representative's first;
     - `sourceRefs` are the union of chunk refs, at most 8, taken in lesson and time order; the report states how many refs were dropped.
   - A read-only `sourceExcerpt` of up to about 2,400 characters is stored for reviewers.
   - `lessons[]` references are derived from the source refs.
7. **Write policy for concept drafts.** Mirrors PR-1.
   - Writes are `drafts.`-prefixed only, with `reviewStatus: needs_review`.
   - An unpublished draft is replaced in place, except when `generation.contentHash` no longer matches its current content. That means an editor changed it, so it is left untouched and reported.
   - A published concept is **never written**. New evidence for it is reported as "evidence for existing concept X" only.
   - `--force` deletes this course's unpublished, unedited generator drafts that the new projection does not reproduce.
8. **Concept revision.**
   - `revision` is an integer starting at 1.
   - Approved content is `readOnly`. To change it, an editor sets the status back to `needs_review`, edits, sets `revision = published.revision + 1`, and approves again.
   - The publish gate blocks any content change without that increment.
   - Content fields: `name`, `aliases`, `summary`, `objectives`, `sourceRefs`, `lessons`.
9. **Merges and splits (tombstones).**
   - `reviewStatus` is one of `needs_review | approved | rejected | merged | split | archived`.
   - `merged` requires `mergedInto` (one concept, not itself).
   - `split` requires `splitInto` (at least 2 concepts, not itself).
   - Tombstones stay published and are never deleted. Strong references from assessments also block deletion.
   - A pure `resolveConcept(conceptId, index)` does the resolution:
     - it follows `mergedInto` for at most 8 hops, with cycle detection;
     - it returns `active` (with the path taken), `split` (targets, plus `requiresReconciliation: true`) or `unavailable` (with a reason).

   **PR-4 contract, documented only:** merges resolve through the chain. Splits never copy mastery to the new concepts; PR-4 marks affected projections for conservative reconciliation.
10. **Prerequisite edges** (`conceptPrerequisite`).
    - Id: `concept-prereq-<sha16(prereqConceptId→dependentConceptId)>`, so each pair has one stable id.
    - Fields: `prerequisite` and `dependent` (strong references), `status` (`proposed | approved | rejected | retired`), `rationale` ≤300, `evidence[]` chunk refs, `generation{…}`.
    - Review checks:
      - `genuineDependency`: learning the dependent needs the prerequisite. Speaking order or topic similarity does not count.
      - `directionCorrect`
      - `evidenceSupports`
    - Writing: generator-only, as `drafts.` with `status: proposed`.
    - Existing documents:
      - published edges are never written;
      - an unpublished draft is replaced in place unless an editor changed it;
      - a pair that already exists as rejected is never re-proposed.
11. **Sequencing, which strong references force.** An edge cannot strongly reference a concept that exists only as a draft, so the steps run in this order:
    1. `extract` drafts concepts.
    2. Editors review and publish them.
    3. `prerequisites` proposes edges among **published, approved** concepts only.

    For the initial audit, `prerequisites --dry-run --concepts-from <extract --out file>` proposes edges over the dry-run concept drafts and writes nothing. `--concepts-from` is refused without `--dry-run`.
12. **Bounded prerequisite call.** One call per course.
    - The call rejects the run when the course has more than 60 concepts; it never truncates.
    - Per concept the input is its label `k<i>`, name, summary, and at most 1 evidence chunk (at most 300 characters) labelled `k<i>e0`, so the input is at most about 40,000 characters.
    - Concepts are sorted by `conceptId`, not by lesson order, so speaking order is not offered as a signal.
    - Output: at most 80 edges, each `{prerequisite: index, dependent: index, rationale, evidence: labels (1–2)}`.
    - The server maps indices and labels through allowlists.
    - It rejects self-edges, out-of-range indices, evidence not from either endpoint, and **mutual pairs (both are rejected)**. It drops duplicates.
    - Cycles among the proposals are reported, not resolved automatically, because they are drafts.
    - A `conceptGenerationRecord` (`kind: course_prerequisites`) gives the step the same skip-unless-`--force` idempotency.
13. **Explicit versions and keys** (constants in `lib/concepts/`, recorded on every draft and record):
    - Constants:
      - `CONCEPT_EXTRACTION_PROMPT_VERSION = 'concept-extraction-v1'`
      - `CONCEPT_EXTRACTION_CONFIG_VERSION = 'spans-12-concepts-2-v1'`
      - `PREREQUISITE_PROMPT_VERSION = 'concept-prerequisites-v1'`
      - `PREREQUISITE_CONFIG_VERSION = 'concepts-60-evidence-1-edges-80-v1'`
    - `extractionKey = hashParts(['concept-extraction', lessonId, videoDocumentId, lessonTitle, chapterLabel ?? '', ordered chunkId@chunkRevision, PROMPT_VERSION, model, CONFIG_VERSION])`.
    - `prerequisiteKey = hashParts(['concept-prerequisites', courseId, sorted conceptId@contentHash, PROMPT_VERSION, model, CONFIG_VERSION])`.
    - `contentHash = hashParts` over the canonical content fields. It serves both to skip identical rewrites and to detect editor changes.
14. **Staleness.**
    - Each `extract` run recomputes chunk revisions for the course's videos.
    - A concept (draft or published) or an edge whose refs **into those videos** no longer match gets `sourceStatus: stale` via a patch. This reuses `isStale` from PR-1.
    - Refs into videos outside the run are not judged.
15. **Assessment link.**
    - A new optional field, `assessment.primaryConcept`, is a reference filtered to approved concepts. There is a single primary concept, as PR-4 requires, and no multi-reference array.
    - The field is **not** in `ASSESSMENT_CONTENT_FIELDS`, so editors can backfill approved items and the gate still lets them publish.
    - Backfilling changes `_rev`, so PR-4 must snapshot the concept id per attempt.
    - Linking is done by editors. `validate` suggests links deterministically by chunk overlap and writes nothing.
16. **Graph validation split.**
    - Studio validation blocks self-edges and invalid merge or split targets.
    - `npm run validate:concepts -- --course <slug>` is read-only and uses the published perspective. It reports:
      - self-edges, duplicate pairs, dangling references;
      - endpoints that are not active (not approved, or a tombstone);
      - inaccessible endpoints: no source lesson is published in a published course;
      - cycles, found with SCC detection.
    - It exits non-zero on any active-graph defect.
    - Coverage: approved concepts with no approved current assessment (resolved through merges), approved assessments without `primaryConcept`, and links to split concepts that need reconciliation.

    Post-hoc validation is acceptable because nothing consumes the graph in PR-3. PR-11 must read only a validated graph.
17. **Gated publish.**
    - `gatePublish(publish, blockReason = publishBlockReason)` becomes parameterized. Assessment behavior is unchanged.
    - New block reasons:
      - concept: publish when approved with every check and the revision rule met, or when it is a tombstone with valid targets;
      - edge: publish when approved with every check, or when retired; endpoints are immutable once published.
    - `concept`, `conceptPrerequisite` and `conceptGenerationRecord` join `GENERATOR_ONLY_TYPES`: no create and no duplicate.
    - Concept review checks: `nameAccurate`, `summarySupported`, `objectivesAssessable`, `notDuplicate`, `granularityAppropriate`.
18. **Model and limits.** OpenAI `gpt-5-mini` via `generateBoundedObject`, reasoning effort `medium`, with no output repair.

    | Call | Timeout | Max output tokens |
    | --- | --- | --- |
    | Extraction | 90 s | 4,000 |
    | Prerequisites | 120 s | 16,000 |

    - The run cap is 100 model calls.
    - Critical rules sit in the inline system prompt: untrusted transcript, no instructions followed, speaking order or similarity is not a prerequisite.
19. **No feature flag, no learner projection, no UI.** No request-path consumer exists, which is the same reasoning as PR-1 Decision 17. The concept learner projection arrives with PR-4.
20. **Credentials and writes.**
    - Reads use `SANITY_API_WRITE_TOKEN`, falling back to `SANITY_API_READ_TOKEN`.
    - Writes require `SANITY_API_WRITE_TOKEN`.
    - **This PR's runs are `--dry-run` only.** Any write to `production`, and any Studio or schema deploy, needs your separate explicit approval.

## Expected files

New:
- Studio:
  - `studio/schemaTypes/documents/{concept,concept-prerequisite,concept-generation-record}.ts`
  - `studio/actions/concept-publish.ts`
- Lib, framework-free with relative `.ts` imports, each module with a `.test.ts`:
  - `lib/concepts/extract.ts`: output schema, prompt, key, candidate mapper
  - `lib/concepts/cluster.ts`: normalization, clustering, id assignment, write plan
  - `lib/concepts/prerequisites.ts`: bounded prompt, key, edge mapper, plan
  - `lib/concepts/graph.ts`: integrity and coverage validator
  - `lib/concepts/resolve.ts`: merge and split resolution
  - `lib/concepts/pipeline.ts`: orchestration with an injected `GenerateFn`
- Scripts:
  - `scripts/generate-concepts.mts`: `extract | prerequisites`, `--course | --lesson`, `--limit`, `--dry-run`, `--force`, `--out`, `--concepts-from`
  - `scripts/validate-concepts.mts`: read-only

Modified:
- Studio:
  - `studio/schemaTypes/index.ts`
  - `studio/schemaTypes/documents/assessment.ts` (`primaryConcept`)
  - `studio/actions/assessment-publish.ts` (parameterized gate)
  - `studio/sanity.config.ts`
  - `studio/structure.ts`, with lists for:
    - concepts: needs review, approved, stale, merged/split/archived, rejected;
    - prerequisites: proposed, approved, rejected/retired;
    - generation records
- Web: `package.json` (`generate:concepts`, `validate:concepts`), `docs/DATA_MODEL.md` (§16 Concepts), `sanity.types.ts` (TypeGen output).

Untouched: all `app/` and `components/` files, which hold your uncommitted dark-theme work, and `.env.example`, which needs no new variables.

## Requirements

1. Extraction is bounded to one span per call and at most 2 candidates. Output passes Zod and the post-generation limits, and chunk refs map through the span allowlist.
2. Records hold validated candidates. An unchanged rerun makes 0 model calls and 0 writes.
3. Clustering and id assignment are deterministic. An existing concept keeps its id, published concepts are never written, and editor-modified drafts are never overwritten.
4. Edge proposals only reference allowlisted concepts and evidence. Self-edges and mutual pairs are rejected, and rejected pairs are never re-proposed.
5. The validator detects every defect class in Decision 16. `resolveConcept` resolves through merges and flags splits.
6. No concept or edge becomes published by any script. Every write is a `drafts.` document or a staleness patch.

## Security

- No new routes and no new browser-exposed values.
- Transcript text and concept text are untrusted. Prompts say so, and output is schema-parsed and allowlisted.
- New types stay out of MCP: the `groqFilter` allowlist is unchanged, and this is verified in manual test 6.
- No learner data in Sanity.

## Acceptance criteria

- Unit tests cover:
  - extraction: bounds and allowlist; over-limit, truncated and generator-language rejection; key stability and change;
  - reruns: record-based rerun idempotency; provider failures not recorded; budget deferral;
  - clustering: determinism, collision suffix, match and conflict against existing concepts, the published-never-written rule, editor-change detection, bounded aliases/objectives/refs;
  - edges: allowlists, self and mutual rejection, rejected pairs not re-proposed, the concept cap refuses rather than truncates;
  - graph and resolution: every validator defect class; merge chain, split, merge cycle and missing concept in resolution;
  - staleness: marking;
  - assessments: the gate still behaves as before.
- Dry runs write nothing:
  1. canary: `extract --limit 2`;
  2. the full pilot course, only if the canary passes;
  3. `prerequisites --dry-run --concepts-from`.
- An audit note records candidate and cluster counts, rejection reasons, and a sample review of concepts and edges.
- Plan acceptance still requires human review of every pilot concept and active edge before anything is published. That is out of scope for this session.

## Checks

- Web (Node 22 via nvm): `npm run typecheck`, `npm run lint`, `npm test`, `npm run typegen`, `npm run build`.
- Studio: `npm --prefix studio run typecheck`, `npm --prefix studio run schema:validate`.
- Lint, typecheck and build run over the working tree, which includes your uncommitted `app/` and `components/` changes. Failures confined to those files are reported separately, not fixed.

## Manual tests

1. `npm run generate:concepts -- extract --course practical-web-security --limit 2 --dry-run --out <scratch>/concepts-canary.json`: the summary lists spans, candidates, clusters and skip reasons, and the dataset is unchanged.
2. Run the same command without `--limit`: the full-course dry run.
3. `npm run generate:concepts -- prerequisites --course practical-web-security --dry-run --concepts-from <scratch>/concepts.json --out <scratch>/edges.json`: proposed edges come with rationale and evidence, rejects carry their reasons, and cycles are reported.
4. `npm run validate:concepts -- --course practical-web-security`: read-only. With nothing published it reports an empty graph and exits 0.
5. *(After your approval to deploy and write.)* Deploy the Studio and schema, then run `extract` without `--dry-run`. In the Studio, check that:
   - Concepts → Needs review shows drafts;
   - Publish stays disabled until the concept is approved with every check ticked;
   - merging A into B publishes a tombstone;
   - an assessment linked to A resolves to B in `validate`.
6. Context MCP probe: `*[_type in ["concept","conceptPrerequisite"]][0...1]` returns `[]`.

## Rollback

- Stop running the generator.
- Set concepts to `archived` and edges to `retired`, then publish, to hide them. Nothing is deleted.
- The schemas are additive, and the Studio structure and action changes revert by commit.
- Search, lessons, assessments and progress are unaffected, and no consumer exists yet.

## Implementation notes (deviations found while building)

- **Shared object type.** `conceptSourceRef` is one registered object type (`studio/schemaTypes/objects/concept-source-ref.ts`), used by concepts, edges and records. Each ref also carries its `lesson`, because one video can back several lessons.
- **Shared HTTP helper.** `scripts/sanity-http.mts` is a small helper shared by the two new CLIs. The PR-1 script is untouched.
- **Studio actions for concepts.** Concepts also lose the Studio `delete` and `unpublish` actions, which enforces the "tombstones are never deleted" rule in Decision 9.
- **Concept id truncation.** Ids are cut at a word boundary: a canary id ended in `…-and-def`.
- **Audit.** Dry-run results and findings are in `prompts/pr-3-concept-audit.md`. The full pilot course produced 88 drafts, so the prerequisite step refuses as designed. This needs a scope decision before review.

## Risks

- **Lexical matching.** It misses synonyms and can merge homonyms; reviewers are the gate.
- **Unreviewed concept ids.** A `--force` rerun can create a duplicate draft with a new id when the model renames a concept without any overlap.
- **Rejected proposals, one-edge cycles.** Rejecting both edges of a mutual pair may discard one real dependency. Cycle-closing edges are only reported.
- **`_rev` changes from backfill.** Backfilling `primaryConcept` changes the `_rev` of published assessments.
- **Tombstone chains.** Tombstone targets are checked for self-reference in the Studio, but for status only in `validate`.
