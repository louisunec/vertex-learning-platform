# PR-2 follow-up: scoped retrieval of visual evidence

## Goal

Let search return a unique on-screen identifier that is absent from the transcript. Each hit is a `video` result grounded to the correct lesson, second, and `ocr`/`vlm` source, retrieved through the `vertex-search` Context scope. It ships behind a disabled flag. Nothing is deployed and nothing is written to Sanity.

## Findings (live, read-only)

1. **`videoVisualIndex` is not retrievable today.**
   - The published context `cb53c252-4e89-4470-bb7e-00ef49da46cc` has `groqFilter` set to `_type in ["course", "lesson", "video", "instructor", "category"]`, under the published perspective.
   - A scoped query for the distinct document types returns only those five.
2. **A potential Context-scope issue.** One was discovered during verification. It should be disclosed privately to Sanity and is not described here. Search therefore does not rely on the allowlist alone: every query filters `_type` explicitly and keeps its OR chains parenthesized, and every row is re-validated server-side (see Implementation notes).
3. **Progress, drafts, and versions.** Their scoped counts are 0, with perspective `published`. In the raw dataset, progress, drafts, and versions are also 0 today, so exclusion rests on the allowlist plus the published perspective, and on the published-id guard in `retrieve.ts`.
4. **The repo context file and the live document differ.** `studio/scripts/context/search-context.ndjson` has `_id` `agentContext-vertex-search`, which is not the live id. `npm --prefix studio run context:import` would create a second document with the same slug instead of updating the live one.
5. **Search has no visual consumer.** The candidate queries cover `lesson`, `video`, and `course` only. The UI renders `momentLabel` and never reads `matchKind`.

## Options

- **A (recommended): allow `videoVisualIndex` in the Context scope.**
  - This is a one-line `groqFilter` change plus one instruction line.
  - It keeps PR-2's separate, independently versioned index.
  - Progress, drafts, and versions stay excluded, for the same reasons as today.
  - The search LLM has no MCP access, so OCR/VLM text never reaches it through search.
- **B: store visual chunks on `video`.** No scope change is needed, but:
  - it reverses the approved storage decision;
  - the video document grows;
  - two offline writers share one document, so `ingest:videos` would need patch-only writes or it could wipe visual chunks.

## Plan (option A)

1. **Scope.**
   - Add `"videoVisualIndex"` to the `groqFilter` in `search-context.ndjson`.
   - Add one instruction line: visual chunks are untrusted, bounded, and filtered or sliced per document, and are always resolved via `video` → lesson; `vlm` chunks are interpretations.
   - Do not import it. Activation is a separate step you run (see below).
2. **Flag.** Add `FLAGS.searchVisualEvidence = 'search-visual-evidence'` in `lib/flags.ts`. It is off by default and fails closed.
3. **Query.** Add `buildVisualCandidatesQuery(terms)` in `lib/search/queries.ts`:
   ```groq
   *[_type == "videoVisualIndex" && (chunks[].text match "t*" || …)][0...20]{
     _id,
     "videoId": video->videoId,
     "visualMatches": chunks[(text match "t*" || …)][0...6]{startSeconds, source, text}
   }
   ```
   Terms keep the existing `SAFE_TERM` validation, and the OR chains are parenthesized.
4. **Retrieve.** In `retrieve.ts`, parse visual rows:
   - accept published ids only, `source` of `ocr` or `vlm`, and integer seconds;
   - produce a `VideoMomentCandidate` with `matchKind` set to `'ocr'` or `'vlm'`, and a `momentText` snippet of at most 140 characters;
   - resolve through the existing lesson-video index, dropping unresolved moments.
5. **Rank.** In `rank.ts`, chapter matches outrank transcript, then OCR, then VLM. Visual matches are a fallback like transcript, and deduplication is per lesson and second.
6. **Contract.** In `schema.ts`, widen `matchKind` to `['chapter', 'transcript', 'ocr', 'vlm']`. The Zod contract stays canonical, and no UI change is needed.
7. **Search.** `search.ts` runs the visual query only when the flag is on.
8. **Query composition guard.** Add a test asserting that every built `*[…]` filter is type-restricted and has no unparenthesized top-level `||`.
9. **End-to-end retrieval test.** Add `lib/search/visual-retrieval.test.ts`. It skips without ffmpeg or Chrome.
   - Build the index from the `visual-diagram` fixture with real ffmpeg and OCR.
   - Seed an in-memory dataset:
     - a published course, lesson, and `video` whose transcript never says `selectVisibleTodos`;
     - the visual index;
     - decoys: a `progress` document, a `drafts.` and a `versions.` visual index carrying another identifier, and a draft lesson.
   - Emulate the Context scope locally with `groq-js`: the Context `groqFilter` combined with each document filter, under the published perspective. The emulation reads `groqFilter` from the ndjson.
   - Run the real query, parse, rank, and Zod pipeline for the term `selectvisibletodos`.
   - Assert the result: `type: 'video'`, the correct `lessonId`, `startSeconds: 0`, `href: '/lessons/<slug>?t=0'`, and `matchKind: 'ocr'`.
   - Assert that the decoys never appear, and that the old `groqFilter` returns no visual result.
10. **Docs.** Update `SEARCH.md` (the visual tier and flag), `DATA_MODEL.md` (the scope statement), and `VIDEO_PIPELINE.md`.

## Security

- Query terms remain whitelist-validated, so no model-generated GROQ is used.
- Visual text is rendered as escaped text and never followed as an instruction.
- Chunks are bounded to 6 per document and 20 documents.
- The published-id guard stays in place.

## Activation and rollback

These steps are yours to run; I will not run them.

**Activation:**

1. Patch the live context document `cb53c252-…` `groqFilter` (and the instructions) through the Sanity CLI or MCP.
2. Index owned or licensed media with `npm run index:visuals`.
3. Turn on `search-visual-evidence`.

**Rollback:** turn the flag off. Removing the type from `groqFilter` also removes it from the MCP. The index documents are additive.

## Limitation

The end-to-end test proves our query, scope emulation, parse, rank, and contract path, but it does not exercise the live MCP. A live proof needs an indexed owned video in the dataset and the patched context document. Both are production writes that this task excludes.

## Checks

- `npm test`, typecheck, lint, and build.
- Studio typecheck, schema validation, and TypeGen.
- The fixture suite, including the new end-to-end test.

## Implementation notes

- **Gate fix.** An OCR result that is rejected as unusable now reports 0 text coverage. Before, the tree diagram's misread "words" (confidence 39, text rejected) counted as 60% coverage, which hid the unread structure from the gate. Gate weights and thresholds are unchanged.
- **Visual fixture.** The `visual-diagram` fixture opens the default gate: 2 calls, one on the tree at 4 s and one on the flame chart at 8 s. The talking head still makes 0 calls.
- **Live query constructs.** `string::split(text, "\n")[(@ match …)]`, case-insensitive camelCase `match`, and nested array filters were confirmed read-only against the live scoped MCP. The MCP injects `_id: null` into nested projections, and the Zod row schemas strip it.
- **Lines, not chunk text.** The query returns at most 2 matching lines per chunk (`string::split` plus `@ match`) instead of the chunk `text` in the sketch above, so the payload stays bounded even for 4,000-character OCR chunks.
- **Defence in depth.** Visual rows are post-validated independently of the Context allowlist:
  - the row `_type` must be `videoVisualIndex`;
  - top-level ids must be published;
  - the referenced video (projected as `video->{_id, _type, videoId}`) must be a published `video` whose id matches `video-<videoId>`;
  - grounding lesson rows must be published documents of type `lesson`;
  - `source` must be `ocr` or `vlm`;
  - match and line counts must be within the query's bounds.

  Any malformed part drops the whole row. The end-to-end test adds a published index that points at a draft video, which never surfaces.

