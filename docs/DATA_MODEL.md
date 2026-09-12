# Vertex Data Model

## 1. Modeling principles

Vertex separates:

- authored learning content,
- internal video-search support data,
- learner-specific application state,
- search configuration.

Use references and derived relationships deliberately.

Do not duplicate data merely to make one query convenient unless a measured requirement justifies denormalization.

---

## 2. Course

A `course` is a top-level Sanity document.

It contains:

- title,
- slug,
- summary/marketing description,
- cover image,
- level,
- price display field,
- optional popular flag,
- student-count display field,
- learning outcomes,
- instructor reference,
- category reference,
- ordered modules.

### Learning outcomes

A short ordered list.

Each outcome contains:

- icon,
- title,
- description.

### Modules

Modules are **embedded objects inside the course**, not standalone documents.

Each module contains:

- title,
- summary,
- ordered references to lessons.

Do not store canonical `Module 1`, `Module 2`, etc. numbering. Derive module number from array order.

---

## 3. Lesson

A `lesson` is a Sanity document.

It contains:

- title,
- slug,
- video URL,
- poster/thumbnail,
- duration,
- free-preview display flag,
- student-count display field,
- notes in Portable Text,
- key points,
- optional pro tip,
- resources.

### Resources

A resource includes:

- type,
- title,
- description,
- URL.

### Parent relationship

A lesson does **not** store its parent course as canonical data.

When course/module context is required, derive it from the course that references the lesson.

Do not add a duplicated parent-course field without an explicit data-model change.

---

## 4. Instructor

An `instructor` is a document containing:

- name,
- slug,
- photo,
- expertise,
- bio.

Instructor information appears on relevant course/lesson surfaces and has its own learner-facing page.

---

## 5. Category

A `category` is a document containing:

- title,
- slug,
- description.

Courses reference categories.

---

## 6. Video

A `video` document is internal search/playback support data.

There is one video document per unique normalized video URL.

It contains at least:

- stable id,
- source URL,
- timestamped chapters,
- timestamped transcript chunks.

### Chapters

```ts
{
  startSeconds: number
  label: string
}
```

### Transcript chunks

```ts
{
  startSeconds: number
  text: string
}
```

Do not store/retrieve the transcript as one giant field for request-path use.

### Evidence identity

Features that cite transcript evidence derive chunk identity with `lib/evidence/chunks.ts`, never ad hoc:

- `chunkId`: `<video document id>:<chunk _key>`,
- `chunkRevision`: a content hash of `startSeconds` + `text`,
- `endSeconds`: the next chunk's start (the last chunk is capped by duration).

These values are computed from stored records, not stored on the video. Changed caption text changes the revision, and anything citing the old revision becomes stale.

Video documents are not independently displayed in learner-facing search results.

A video result is always resolved through the lesson that uses the video's URL.

---

## 7. Search Context

The search Context document stores configurable search-agent context such as:

- content-scope filter,
- concise query/search guidance.

It is configuration data.

It is not:

- the runtime result contract,
- the source of truth for ranking weights,
- a replacement for application authorization.

---

## 8. Progress

A progress record represents learner-specific state.

It is keyed/owned by the authenticated Clerk user identity.

It captures at least:

- completed lesson state,
- last/resume position for a lesson.

Exact persistence shape should follow the project's canonical schema and expected query/write patterns.

### Rules

- progress remains separate from authored course/lesson content,
- the browser does not write it directly,
- server-side code resolves the authenticated user,
- client-supplied user ids must not be trusted as authority.

---

## 9. Portable Text

Lesson notes use Portable Text.

Do not store canonical lesson notes as Markdown.

When search requires text matching over notes:

- project Portable Text into searchable plain text or use an existing supported helper/pattern,
- do not assume raw Portable Text arrays behave as simple strings.

Rendering should use the project's existing Portable Text renderer.

---

## 10. Derived values

Prefer deterministic derivation for values whose truth comes from structure.

Examples:

- module number from module order,
- lesson number from lesson reference order,
- course context for a lesson from reverse reference,
- video result's lesson/course context from real relationships.

Do not persist duplicate labels solely for display convenience unless there is a clear performance/authoring need.

---

## 11. IDs and slugs

Use Sanity/project conventions for document ids and slugs.

Video ids should be deterministically derived from normalized source URLs while stripping/replacing characters rejected by the datastore.

The normalization algorithm should be stable and tested so repeat ingestion updates the same logical video rather than creating duplicates.

---

## 12. Referential integrity expectations

Implementation should account for:

- missing instructor/category references,
- lessons removed from modules,
- a lesson video URL with no ingested video record,
- duplicate video URLs,
- malformed/empty chapter or transcript arrays.

Search must fail/degrade safely when relationships cannot be resolved.

Do not fabricate relationship data to complete a result.

---

## 13. Schema evolution

Schema changes are high-risk changes.

For any meaningful schema change:

- inspect existing content,
- assess compatibility with current queries/types,
- account for TypeGen,
- define migration/backfill when necessary,
- include rollback/recovery considerations,
- deploy and verify the Studio/schema through the correct workspace process.

Do not casually rename/remove populated fields without a migration plan.

---

## 14. Source-of-truth rule

This document describes stable modeling intent.

Once concrete schemas/types exist, the canonical implementation lives in:

- Sanity schema definitions,
- generated types,
- runtime validation schemas,
- migrations.

If this document and code disagree, do not silently guess. Identify the conflict in the implementation prompt.

---

## 15. Assessments

An `assessment` document is one version of a single-choice practice item for a lesson. The generator (`npm run generate:assessments`) drafts it from one bounded transcript span; it is the only way to create one (the Studio has no create or duplicate action for assessments). It is served only after editorial review.

- Identity: a stable `familyId` plus an integer `version`, with id `assessment-<familyId>-v<version>`. Section families are `asm-<sha8(lesson)>-s<span>-q<ordinal>`. Each lesson also has one transfer family, `asm-<sha8(lesson)>-t-q0`.
- Regeneration replaces a family's unpublished latest draft in place (same id). When the latest version is published, the generator drafts the next version, and it never writes a published version. `--force` also deletes unpublished drafts that the new output does not reproduce.
- Options are stored in a deterministic seeded-shuffle order. Option ids (`_key`) derive from the option text. The answer key holds `correctOptionId`, `correctReason`, and `distractorReasons[] {optionId, reason}`: one short reason per wrong option, tied to its id and never to its position. No answer index is stored.
- The generator never truncates text. Field limits are checked after generation, and the schema sent to the model carries no string `maxLength`, because strict structured output would cut text mid-word at that limit. Over-limit, cut-off, or corrupted text rejects the candidate, as does wording that points at a source learners cannot see ("the instructor", "find the sentence that…", chunk labels such as `c0`).
- The lesson is referenced from the assessment. The lesson does not list its assessments.
- `answerKey`, `hints`, `sourceExcerpt`, and `generation` are private. The learner projection (`sanity/queries/assessments.ts`, parsed by `lib/assessments/learner.ts`) never selects them. It returns approved, `current`, published items only, one per family (the latest such version), before applying its per-lesson bound.
- `reviewStatus` (`needs_review | approved | rejected | archived`) is separate from Sanity's publish state. The Studio publishes an item only when it is approved with every review check ticked, or when it is archived.
- `sourceStatus` becomes `stale` when a cited chunk's revision changes. Stale items are not served.
- Approved content is read-only in the Studio, and a draft that changes the content of any published version (approved or archived) cannot publish. The API does not enforce this, so attempts record the exact `_id` and `_rev` they were delivered.
- Every unit the generator processes gets an `assessmentGenerationRecord` with id `assessment-generation-<key>`. A unit is either a section (`kind: section`, recall/apply items) or the lesson's single transfer call over one chosen span (`kind: lesson_transfer`). The key covers every prompt input (lesson, video, lesson title, chapter label, ordered chunk revisions) plus prompt, model and config versions, so a renamed lesson or chapter is generated again. The record's outcome is `drafted`, `no_candidates` or `all_rejected`, and it is written in the same transaction as that unit's drafts. Reruns skip recorded units unless `--force` is passed. Provider failures leave no record and are retried. Records are an operational log: never assessments, never served to learners, and read-only in the Studio.
- `primaryConcept` (optional reference to an approved `concept`) names the single concept an item is evidence for. It is an association, not item content: it stays editable after approval and is not covered by the immutability rule, so linking changes `_rev`. Evidence records (PR-4) must therefore snapshot the concept id they counted.

## 16. Concepts and prerequisites

Concepts are the reviewed skill vocabulary. A generator (`npm run generate:concepts`) drafts them, and they are published only after editorial review. Learner mastery is never stored in Sanity; it belongs to the learner database (PR-4).

- **Identity.** `conceptId` (`cpt-<kebab name>`, with `-2`, `-3` … on collision, at most 48 characters) is assigned when a concept is first drafted. The document id is `concept-<conceptId>`. The id never changes, even when the concept is renamed.
- **Content.** A concept has `name`, `aliases` (at most 8), `summary`, `objectives[]` (1–4, each with a stable `_key`), `sourceRefs[]` (at most 8 `conceptSourceRef`s: `chunkId`, `chunkRevision`, times and lesson, with the same identity as `lib/evidence/chunks.ts`), `lessons[]`, and an editorial-only `sourceExcerpt`.
- **Revision.** `revision` starts at 1. A published change to the content fields needs `revision + 1`, and only then; the Studio publish gate enforces it.
- **Lifecycle.** `reviewStatus` is one of `needs_review | approved | rejected | merged | split | archived`. Only `approved` concepts are active.
  - `merged` requires `mergedInto`, and `split` requires at least two `splitInto` concepts. Both stay published as tombstones.
  - Concepts have no delete, unpublish, duplicate or schedule-publish action in the Studio, and assessment references also block deletion. "Discard changes" is disabled on a never-published concept or edge (it would delete a generated draft, and rejected ones are kept for audit).
  - Studio publish gates are client-side document actions: a Releases workflow is not gated.
  - `lib/concepts/resolve.ts` follows merges (at most 8 hops, with cycle detection). A split never resolves to one concept: learner projections reconcile it conservatively.
- **`sourceStatus`** becomes `stale` when a cited chunk changes, for concepts and edges alike.
- **Generation.**
  - One model call per bounded transcript span (`lib/assessments/spans.ts`) returns one primary concept, plus a secondary only when that secondary is independently teachable and testable. The call also returns the facts and details it left out.
  - Examples, usernames, command output and one-off implementation details are not concepts. Names that look like literals, identifiers, flags or file names are rejected deterministically (`incidental_detail`).
  - Aliases are limited to abbreviations, spelling variants and established synonyms. The alias rule (`filterAliases`) runs at extraction and again in the projection, so a component identifier such as a directive (`script-src`) or a narrower member name never becomes an alias; it stays in the concept's evidence and objectives.
  - Each processed span gets a `conceptGenerationRecord` (`kind: span_extraction`, id `concept-generation-<key>`). It holds the span's validated candidates, each with a stable `candidateId` (its `_key`), a `role` and a `fingerprint`. It also keeps rejected candidates for audit.
  - Concept drafts are a deterministic projection of every current record of the course. Candidates sharing a normalized name or alias are joined, and existing concepts are matched the same way. Drafts record their `candidateIds`, `role` and `suppressionKey`.
  - The generator writes `drafts.` documents only. It never writes a published concept and never overwrites a draft an editor changed (`generation.contentHash`).
  - Versions are explicit:

    | Step | Prompt | Config |
    | --- | --- | --- |
    | Extraction | `concept-extraction-v2` | `spans-12-primary-1-secondary-1-v2` |
    | Consolidation | `concept-consolidation-v2` | `concepts-120-evidence-1-groups-40-v1` |
    | Prerequisites | `concept-prerequisites-v1` | `concepts-60-evidence-1-edges-80-v1` |
- **Consolidation** (`conceptMergeProposal`).
  - Lexical matching misses synonyms. So one bounded course-level call over the course's reviewable concepts (at most 120, refused rather than truncated above that) proposes merge groups of **semantically equivalent** concepts only.
  - The model labels each group's relation (`same_concept | subtopic | related | attack_and_defence`). Only `same_concept` groups are kept; the rest are rejected as `not_equivalent:<relation>`. The label is validation-only and never stored.
  - Each group has members identified by stable candidate ids, a canonical member, a rationale and evidence chunks. Accepted members' names become aliases of the canonical.
  - Proposals are drafts with status `proposed`, and an editor accepts or rejects each one in the Studio. Proposals have no publish, schedule, duplicate, delete or discard action.
  - The next `extract` run applies an **accepted** proposal to unpublished drafts only. It joins the members under the canonical concept and deletes the other members' unedited generator drafts.
  - Rejecting a proposal never removes a concept. If it was already applied, the next `extract` run restores each absorbed member under its original `conceptId` (matched by candidate ids) and re-projects the canonical from its own candidates. Setting it back to `proposed` does the same. Two projections that resolve to one concept id are reported as a conflict, and neither is written.
  - A proposal that touches a published concept is never applied: it is merged by hand with a tombstone. A proposal whose candidates no longer exist is ignored as stale.
- **Rejection suppression.** Rejected concepts, edges and proposals are never touched and never reach the published graph automatically.
  - Each carries a suppression key:
    - concepts: candidate fingerprints, cited chunk revisions, and prompt and config versions;
    - edges: the pair, both concepts' content hashes, and the versions;
    - proposals: member candidate ids and the versions.
  - The same key is suppressed. A different key, meaning the source or generation versions changed, is reconsidered as a **new** `needs_review` document that points back to the rejected one (`reconsiders`).
  - `split` and `archived` concepts stay terminal.
- **Prerequisite edges** (`conceptPrerequisite`).
  - An edge is one document per ordered pair, with id `concept-prereq-<sha16(prerequisite conceptId, dependent conceptId)>`. It carries `prerequisite`, `dependent`, `status` (`proposed | approved | rejected | retired`), `rationale`, and `evidence[]` chunk refs.
  - Edges are proposed only among published, approved concepts, in one bounded course-level call (a `kind: course_prerequisites` record). The call takes at most 60 concepts, and it is refused rather than truncated above that.
  - Speaking order and topic similarity are not prerequisites. Both directions of a pair are rejected. The pair's first edge has the base id; a reconsideration after a rejection gets a suffixed id.
  - An edge publishes only when approved with every review check ticked, or when retired. Its endpoints never change once it is published.
- **Validation.** `npm run validate:concepts -- --course <slug>` reads the published perspective only. It reports:
  - self-edges, duplicate pairs, dangling endpoints;
  - inactive endpoints (not approved, including tombstones);
  - inaccessible endpoints (no lesson in a published course);
  - cycles;
  - assessment coverage.

  It exits non-zero on any graph defect. Any consumer of the graph must read only a validated graph.
- Concepts, edges, merge proposals, and records are outside the search Context MCP `groqFilter` allowlist and are never learner search results.
