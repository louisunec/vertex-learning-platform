# Offline video ingestion pipeline

## Goal

Build the offline tool that creates/updates `video` documents (timestamped
transcript chunks + chapter markers) for every lesson video, per
`docs/VIDEO_PIPELINE.md`. The consuming side already exists — schema
(`studio/schemaTypes/documents/video.ts`), identity (`lib/video/provider.ts`),
seek (`lib/video/embed.ts`), search retrieval (`lib/search/queries.ts`,
`sanity/data/videos.ts`) — only ingestion is missing.

## Guidance read

- `docs/VIDEO_PIPELINE.md` (whole document — the spec for this task).
- `AGENTS.md` §2, §8 (ingestion offline, no whole transcripts in request path).
- `studio/scripts/seed/README.md` ("`video` documents … come from the offline
  ingestion tool").

## Code inspected

- `lib/video/provider.ts` — `parseVideoUrl` already yields
  `videoId`/`documentId`/`canonicalUrl`; its header says it is shared with the
  ingestion tool, so ingestion lives in the web workspace and reuses it.
- `studio/schemaTypes/documents/video.ts`, `objects/chapter.ts`,
  `objects/transcript-chunk.ts` — target shape; integer `startSeconds`
  required; doc id convention `video-<videoId>`.
- `sanity.types.ts` `Video` type — generated field names to match exactly.
- `lib/search/queries.ts` — chapter-first matching with transcript fallback is
  already implemented against these fields; `MAX_MOMENTS_PER_VIDEO` bounds.
- `studio/scripts/seed/videos.json` — the 120 seeded lessons all use YouTube.
- `tsconfig.json` (`**/*.ts`/`**/*.mts` included, `allowImportingTsExtensions`)
  and `eslint.config.mjs` (does not ignore `scripts/`) — a root `scripts/`
  tool is covered by `npm run typecheck` and `npm run lint`.

## Spike results (verified 2026-09-09, seed video `9602Yzvd7ik`)

- Anonymous `timedtext` URLs scraped from the watch page return **empty
  bodies** — the watch-page approach is dead.
- The Innertube endpoint `POST https://www.youtube.com/youtubei/v1/player`
  with the `ANDROID` client context (no API key, no cookies) returns
  `playabilityStatus.status: "OK"`, `videoDetails.title` / `lengthSeconds`,
  and `captions.playerCaptionsTracklistRenderer.captionTracks[]` whose
  `baseUrl` **does** return content. With `fmt=json3` forced on the URL it
  returns JSON `events[]` of `{tStartMs, segs: [{utf8, tOffsetMs?}]}`.
- `videoDetails.shortDescription` carries `MM:SS Label` chapter lines for the
  seed videos (verified: 7 chapters for `9602Yzvd7ik`).

## Decisions / assumptions

1. **Location & runtime**: `scripts/ingest-videos.mts` at the web-workspace
   root, run with `node --env-file-if-exists=.env.local` (Node 22 strips types
   natively; erasable syntax only, relative imports with explicit `.ts`
   extension, as `lib/video/embed.ts` already does). Pure logic goes in
   `lib/video/ingest.ts` so the existing `node --test 'lib/**/*.test.ts'`
   runner covers it.
2. **Provider scope**: YouTube ingestion adapter only in this pass. Vimeo and
   Bunny caption/chapter APIs require account credentials we don't have; the
   tool fails fast per URL with `ingestion not supported for provider
   "vimeo"/"bunny"` and writes nothing (VIDEO_PIPELINE §2: a provider is not
   "supported" from embed capability alone — YouTube becomes the only fully
   supported provider, matching the all-YouTube seed catalogue). The adapter
   boundary (§10) keeps Vimeo/Bunny additive later.
3. **YouTube adapter** (no API key): one Innertube `player` call per video
   (ANDROID client) → title, `lengthSeconds`, caption tracks; prefer a manual
   English track over `kind: "asr"`, else first track. Fetch the track with
   `fmt=json3`. Chapters parsed from `shortDescription` lines matching
   `H?:MM:SS Label`; require ≥2 ascending timestamps starting at `0:00`
   (YouTube's own chapter rule) or discard as noise. Sequential requests with
   a ~300 ms delay.
4. **Chunking**: merge consecutive json3 events into chunks closed at
   ~30 s or ~300 chars, whichever first; `startSeconds =
   floor(firstEvent.tStartMs/1000)`; whitespace-collapsed, non-empty text;
   monotonically non-decreasing starts clamped to `[0, duration]`. Exact
   numbers are constants in `lib/video/ingest.ts` with a comment.
5. **Field ownership (§12)**: the tool owns `videoId`, `provider`,
   `providerVideoId`, `sourceUrl`, `title`, `durationSeconds`,
   `transcriptChunks`, `ingestedAt`. `chapters` is Studio-editable: the tool
   reads the existing doc first and keeps existing chapters unless it ingested
   ≥1 chapter and the existing doc has none (or `--overwrite-chapters` is
   passed). Write is `createOrReplace` on `_id = parsed.documentId` with the
   merged doc — idempotent, no duplicates.
6. **Write-or-skip (§11)**: no usable transcript chunks **and** no chapters →
   skip the URL, report the reason, write nothing. Chapters-only is a valid
   document.
7. **Sanity write**: plain `fetch` to
   `https://<projectId>.api.sanity.io/v<apiVersion>/data/mutate/<dataset>`
   and `/data/query/<dataset>` (for the lesson list + existing-doc read) using
   a new `SANITY_API_WRITE_TOKEN`. No new dependency; `next-sanity` /
   `sanity/lib/client.ts` are not imported from the script (`server-only`,
   Next-coupled). Every array item gets a deterministic `_key`
   (`ch-<startSeconds>` / `tc-<startSeconds>-<n>`). The built document is
   validated with a Zod schema (already a dependency) before writing.
8. **Inputs**: default = every lesson with `defined(videoUrl)` (the
   `videoUrl`s deduped via `parseVideoUrl().videoId`); or explicit URLs as CLI
   args. Flags: `--dry-run` (build + validate + report, no write), `--limit
   N`, `--overwrite-chapters`. Summary table + non-zero exit if any URL
   failed (skips for unsupported providers are reported but, for Vimeo/Bunny,
   expected).

## Expected files

- `lib/video/ingest.ts` — new: pure, framework-free chunking
  (`chunkCaptionEvents`), json3 event normalization, description-chapter
  parsing (`parseDescriptionChapters`), video-document builder + Zod schema.
- `lib/video/ingest.test.ts` — new: node:test coverage for the above.
- `scripts/ingest-videos.mts` — new: CLI, YouTube Innertube adapter, Sanity
  read/mutate via fetch, per-URL error handling, summary.
- `package.json` — new script `"ingest:videos": "node
  --env-file-if-exists=.env.local scripts/ingest-videos.mts"`.
- `.env.example` — add `SANITY_API_WRITE_TOKEN` (offline tooling only, never
  read by the app, never `NEXT_PUBLIC_`).

## Requirements

- Deterministic id: rerunning for the same URL updates `video-<videoId>`;
  trivial URL variants collapse via the existing `parseVideoUrl`.
- Integer `startSeconds` ≥ 0 on every chapter/chunk (schema validation).
- Failure handling per §11: unsupported provider, malformed URL, unplayable
  video, no caption tracks, empty transcript, and per-URL fetch errors are
  each reported distinctly; one bad URL never aborts the run.
- The request path is untouched: no web/app files change.

## Security

- `SANITY_API_WRITE_TOKEN` stays in `.env.local`/CI secrets; documented in
  `.env.example` as tooling-only. No secrets written into documents.
- No credentials sent to YouTube; only public Innertube endpoints.
- GROQ/mutations built from parsed, validated values only.

## Acceptance criteria

- `npm run ingest:videos -- --dry-run --limit 2` reports parsed identity,
  chapter count, chunk count, and would-write summary without writing.
- `npm run ingest:videos -- <one seed YouTube URL>` creates
  `video-youtube-<id>` with ≥1 chapter and short timestamped chunks; a rerun
  updates the same document (same `_id`, no duplicate; `ingestedAt` moves).
- Manually authored chapters on an existing doc survive a rerun without
  `--overwrite-chapters`.
- A URL with captions disabled and no chapters is skipped with a clear reason
  and no document.
- Vimeo/Bunny URLs report "ingestion not supported", exit summary reflects it.

## Checks

- `npm run typecheck`, `npm run lint`, `npm test` (includes new
  `ingest.test.ts`) — all from the web workspace root.

## Manual tests

1. `npm run ingest:videos -- --dry-run "https://www.youtube.com/watch?v=9602Yzvd7ik"`
   → prints identity `youtube-9602Yzvd7ik`, ~7 chapters, chunk count, no write.
2. Same command without `--dry-run` → in Studio, the Video preview shows
   `youtube-9602Yzvd7ik · 7 chapters · N chunks`.
3. Re-run the same command → still exactly one document with that id.
4. On `/search`, query "file based routing" → a video-moment result deep-links
   to the Routing lesson; the embed starts at the chapter's second.
5. `npm run ingest:videos` (no args) → ingests the full seed catalogue,
   summary lists successes/skips/failures.
