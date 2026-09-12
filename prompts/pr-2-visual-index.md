# PR-2: OCR-first visual index with a gated VLM

## Blocker first

As specified, PR-2 cannot run on the pilot course. The media pipeline only fetches YouTube captions and chapters (through the public player endpoint) and never has video frames. All 12 pilot lessons are **third-party YouTube videos**, and the only way to get their frames is to download the streams. That is a terms-of-service and copyright decision for you, not an engineering default, and I recommend against it. The development plan treats PR-2 as "optional enrichment, not a prerequisite for a transcript-only pilot" and schedules it in rollout phase 4.

Recommended scope: build the pipeline behind a **local owned-media input adapter**, prove it on **synthetic fixtures**, and defer pilot enrichment until a licensed or owned media source exists.

## Goal

Index useful on-screen text that speech never says (code, identifiers, slide text) at the times it appears, with bounded processing cost. OCR comes first. A vision model (VLM) runs only when a documented gate justifies it. **Index only**: no search, tutor, or assessment consumer in this PR.

## Guidance read

- Development plan: §3 (evidence versioning; OCR text is untrusted), §4 (dependencies and rollout), §5 PR-2.
- `AGENTS.md` §2, §3 (a schema change is high-risk), §8, §10.
- `docs/VIDEO_PIPELINE.md` and `docs/DATA_MODEL.md` §6 (evidence identity).

## Code and environment inspected

- `scripts/ingest-videos.mts`, `lib/video/{ingest,provider}.ts`: captions and chapters only, YouTube only, no media.
- `studio/schemaTypes/documents/video.ts`: `transcriptChunks` and `chapters` are stored inline.
- `lib/evidence/chunks.ts` (PR-1): transcript chunk identity.
- `lib/ai/contracts.ts` (PR-0): `evidenceRefSchema {chunkId, chunkRevision}` and `resolvedCitationSchema`.
- `lib/ai/gateway.ts`: `generateBoundedObject` takes a text prompt only, with no image parts yet.
- Local tools: **ffmpeg, ffprobe, tesseract and yt-dlp are all not installed.**

## Decisions

### 1. Media input

- A new `lib/visual/media.ts` input adapter: `--file <path> --video <videoDocId>`. The file must be owned or licensed; the script says so and records a content hash of the file as `sourceRevision`.
- No YouTube or other downloading.
- Vimeo and Bunny owner-API adapters can follow later behind the same interface.

### 2. Evidence contract

This extends the shared PR-1 contract rather than forking it.

- `lib/evidence/chunks.ts` gains `source: 'transcript' | 'ocr' | 'vlm'` on `SourceChunk`.
- Visual chunk identity:
  - `chunkId = <visualIndexDocId>:<_key>`;
  - `chunkRevision = sha256(source, start, end, text, extractionVersion)`.
- Transcript identity is unchanged, so PR-1 revisions stay valid.
- `resolvedCitationSchema` gains an optional `source`. `evidenceRefSchema` is unchanged.

### 3. Storage

Recommended: a **separate `videoVisualIndex` document** per video, with id `visual-<videoDocId>`, rather than more inline arrays on `video`. Reasons:

- the video document stays small;
- re-extraction can be versioned independently;
- per-video cost and coverage live with the index.

Fields:

- `video` (reference), `extractionVersion`, `sourceRevision`;
- `chunks[]`:
  - `_key`, `source: ocr | vlm`, `startSeconds`, `endSeconds`, `text`;
  - `frameRef {timestampSeconds, frameHash}`;
  - `quality {ocrConfidence, textDensity}`;
  - for VLM chunks, a `vlmLabel`;
- `coverage`: frames sampled, frames OCR'd, VLM calls, `skippedSpans[] {start, end, reason}`, `partial`, `estimatedCostUsd`, `durationMs`.

In the Studio it is read-only and absent from the create menu. It is excluded from the Context MCP (that allowlist is by type) and from learner queries. The no-whole-chunk-array rule still applies to any future consumer.

### 4. Frame sampling

Three signals decide which frames are kept:

- periodic frames (default 1 per 2 s);
- ffmpeg scene scores, with 0.3 as an experiment starting point (the plan warns it can miss code edits);
- text-region change: the difference between downscaled greyscale frames, weighted towards high-contrast, text-like regions.

A frame is kept if any signal fires. Everything is capped per video.

### 5. OCR, then merge

- OCR engine: `tesseract.js` (npm, WASM, no system package), capturing per-word confidence.
- Consecutive texts merge only when they are equal after whitespace normalization, or at least 90% similar **with no changed token** that contains an operator, digit, or identifier character.
- Appearance intervals are preserved.
- Explicit test: `x < 10` and `x <= 10` both survive as separate chunks.

### 6. VLM gate

- A configurable score built from visual change, low OCR confidence or text density, and transcript context near that time. A deictic word ("as you can see here") alone is neither necessary nor sufficient.
- Calls go through `generateBoundedObject`, extended to accept one image part, using a vision-capable model (`gpt-5-mini`).
- Output is short, labelled `vlm`, bounded, and stored as an interpretation, never as ground truth.
- The talking-head fixture must produce **0 VLM calls**.

### 7. Budgets and coverage

- Per-video caps on frames, OCR frames, VLM calls, wall time, and estimated spend (a price table in config).
- Hitting a cap records skipped spans and marks `partial`. Nothing is dropped silently.
- A per-video log line reports cost and coverage.

### 8. Untrusted text

OCR and VLM text is data. It is never followed as an instruction, never executed, and never used as authoritative code for grading. Prompts say this inline (AGENTS §10).

### 9. Fixtures

- Four synthetic clips are generated at test time with ffmpeg `drawtext` from built-in fonts, never from third-party footage:
  - silent typing;
  - a static screen with a one-character code edit;
  - a slide change;
  - a talking head (moving shapes, no text).
- Nothing binary is committed.
- Pure logic (merge, gate, caps, coverage, identity) has unit tests that always run. Integration tests that need ffmpeg and OCR skip with a clear message when the tools are missing.

### 10. Scope boundary and flags

- No retrieval or generation consumer, so there is no feature flag yet. The plan's rollback, "disable visual retrieval", applies once PR-6 or later consumes it.
- Branch: stacked on `feat/pr-1-reviewed-assessments` (PR #7), because it extends PR-1's evidence module.

## Migration and rollback (high-risk: schema change)

- The new document type is additive. No existing documents change.
- Rollback: revert the commit and delete any `videoVisualIndex` documents. Nothing references them yet.

## Expected files

- **New:**
  - `lib/visual/{media,sampling,ocr,merge,gate,budget,index}.ts` and their tests;
  - `scripts/index-visuals.mts`;
  - `scripts/fixtures/make-visual-fixtures.mts`;
  - `studio/schemaTypes/documents/video-visual-index.ts`.
- **Modified:**
  - `lib/evidence/chunks.ts`, `lib/ai/contracts.ts`, `lib/ai/gateway.ts` (image part), and their tests;
  - `studio/schemaTypes/index.ts`, `studio/structure.ts`, `studio/sanity.config.ts`;
  - `sanity.types.ts`;
  - `package.json` and lockfile (`tesseract.js`);
  - `docs/{DATA_MODEL,VIDEO_PIPELINE}.md`;
  - `.env.example` (caps and price table).

## Acceptance

Taken from the plan and applied to the synthetic fixtures:

- identifiers are retrievable at valid times;
- the one-character code edit survives merging;
- slide changes are indexed;
- the talking-head fixture produces 0 VLM calls;
- per-video cost and coverage are logged;
- caps produce recorded skipped spans.

No run against pilot YouTube content, no production writes, and no deploy.

## Checks

`npm test`, typecheck, lint, build, `npm run typegen`, Studio typecheck, and schema validation, plus the fixture integration run once ffmpeg is available.

## Implementation notes

Deviations from the plan above, made during implementation:

- **Fixtures use Chrome, not drawtext.** Homebrew's `ffmpeg` 9.0.1 has no `drawtext` filter because freetype isn't linked. At your direction, code and slide frames are rendered from local HTML with system fonts by headless Chrome, then encoded with ffmpeg; the talking head is still ffmpeg shapes. Headless Chrome can hang after writing a screenshot, so the generator waits for the PNG and then kills Chrome's process group.
- **Stricter merge rule.** On its own, the 90% rule merged "Slide A title" with "Slide B title". A similar-but-different text now merges only when every changed word pairs one-to-one with a close spelling variant (at least 4 characters, at most 2 edits, and not on a code-like line).
- **New file `lib/visual/vlm.ts`.** It holds the VLM prompt and schema and the describer built on `generateBoundedObject`.
- **`tesseract.js` is a devDependency.** Only offline tooling uses it. Its English traineddata is cached in `node_modules/.cache/tesseract`.
- **Three PR-1 test fixtures changed.** `quality`, `spans`, and `generate` tests add `source: 'transcript'` to their `SourceChunk` literals.
- **Scene detection never fired on the fixtures** at 0.3, as the plan warned. The text-region-change signal caught the slide changes and the code edit.
