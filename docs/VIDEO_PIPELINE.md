# Vertex Video Pipeline

## 1. Purpose

The video pipeline turns supported provider videos into structured data that search can use to identify precise moments.

It produces:

- chapter markers,
- short timestamped transcript chunks,
- stable video records.

The pipeline is offline tooling.

It never runs in the learner request path.

---

## 2. Supported providers

The intended provider set is:

- YouTube,
- Vimeo,
- Bunny.

A provider is not considered fully supported until **both** sides exist:

1. ingestion can obtain/construct captions and chapters,
2. the lesson page can embed and seek/start playback at a supplied second.

Do not declare a provider supported from embed capability alone.

---

## 3. Input

The primary identity is the lesson's provider video URL.

For each URL, ingestion should:

1. identify provider,
2. normalize the URL,
3. derive a stable datastore-safe video id,
4. fetch/parse captions,
5. obtain source chapters or use explicitly authored chapters,
6. chunk captions into short timestamped pieces,
7. write/update the corresponding video document.

Repeat ingestion should update the same logical video record.

---

## 4. Video id normalization

The video document id must be deterministic from the source URL or provider/video identity.

Requirements:

- stable across repeated ingestion,
- datastore-safe,
- avoids characters rejected by Sanity document ids,
- prevents accidental duplicates caused by trivial URL variants where normalization can safely resolve them.

Provider-specific canonicalization may be necessary.

Do not build aggressive URL rewriting that could merge two genuinely different videos.

---

## 5. Chapters

Store chapters as:

```ts
{
  startSeconds: number
  label: string
}
```

Chapters are the preferred source for video-moment search because labels are cleaner and less noisy than raw transcript text.

If a provider exposes useful source chapters, preserve their meaning while normalizing the structure.

If chapters are authored manually, treat them as curated source data rather than model-invented facts.

---

## 6. Transcript chunks

Store transcript as many short timestamped chunks:

```ts
{
  startSeconds: number
  text: string
}
```

Do not treat one full transcript blob as the primary request-path representation.

Chunking goals:

- preserve enough local context for matching,
- retain an accurate start second,
- keep retrieval payloads bounded,
- make individual matched moments useful without sending the entire transcript.

Exact chunk duration/size should be an implementation decision informed by caption structure and search quality.

---

## 7. Search usage

Video search follows this order:

```text
query
  ↓
match chapter labels
  ↓ useful match?
yes → create grounded video candidates
no  → search bounded transcript chunks
```

Transcript search is a fallback, not an excuse to load every chunk into the model.

Search retrieves only a small relevant subset of chunks per candidate video.

See `SEARCH.md`.

---

## 8. Lesson relationship

The video document does not independently become a learner result.

To create a video result:

1. find a grounded matching video moment,
2. resolve the lesson using that video URL,
3. resolve course/module context from the real curriculum relationship,
4. build a validated `video` search result.

If no lesson uses the video, the raw video match is not a valid learner-facing result.

---

## 9. Playback

Lesson playback uses provider embeds.

Do not build a custom video player by default.

Search navigation should carry an exact `startSeconds` value to the lesson page.

The lesson page/provider adapter converts that into the provider's supported start/seek mechanism.

Provider logic should remain isolated enough that adding/fixing one provider does not scatter URL parsing and seek behavior across unrelated UI components.

---

## 10. Provider adapters

Prefer an explicit provider boundary for logic such as:

- URL parsing,
- canonical video identity,
- embed URL construction,
- start-time parameter/seek behavior,
- caption ingestion,
- chapter ingestion.

A conceptual interface may include:

```ts
detect(url)
normalize(url)
getVideoId(url)
getEmbedSource(url, startSeconds?)
ingestCaptions(...)
ingestChapters(...)
```

Use the project's existing abstractions if they already solve this. Do not add an abstraction layer solely because this document shows a conceptual shape.

---

## 11. Failure handling

The pipeline should clearly handle:

- unsupported provider,
- malformed URL,
- captions unavailable,
- captions disabled/private,
- chapter metadata unavailable,
- provider API/tool failure,
- empty transcript,
- invalid timestamps,
- duplicate/previously ingested video,
- partial update failure.

Do not create a "successful" video document that implies transcript search is available when ingestion did not actually produce usable transcript/chapter data.

---

## 12. Idempotency

Ingestion should be safe to rerun.

A rerun for the same normalized video should update/replace appropriate generated fields rather than create uncontrolled duplicate video documents.

Preserve intentionally authored data according to the project's chosen ownership rules.

If generated and manually authored fields coexist, document which side owns each field before implementing destructive overwrites.

---

## 13. Request-path limits

The web/search request path must never:

- download captions on demand,
- regenerate chapters,
- ingest a provider video,
- retrieve every transcript chunk,
- send a whole transcript to the LLM/browser.

The request path consumes already-ingested data.

---

## 14. Security

Provider credentials/API keys, if required, remain server/tooling-side.

Do not expose private ingestion credentials to the learner browser.

Do not write provider secrets into Sanity content documents.

---

## 15. Verification

For ingestion changes, verify as applicable:

- URL/provider detection,
- stable id generation,
- idempotent rerun,
- chapter timestamps,
- transcript chunk timestamps,
- no giant transcript field in request payloads,
- search chapter-first behavior,
- transcript fallback,
- correct lesson relationship,
- on-site playback from `startSeconds`,
- each declared provider supports both ingestion and playback.

Provider support is complete only when an actual ingested result can be opened and played at the expected second.
