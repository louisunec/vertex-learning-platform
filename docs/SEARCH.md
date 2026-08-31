# Vertex Search Specification

## 1. Purpose

Vertex search converts a learner's natural-language query into grounded lesson and video-moment results.

It is designed to answer:

- **Which lesson teaches this?**
- **Where in a lesson video is this concept taught?**

Search is not a conversational tutor.

---

## 2. User-facing result types

The canonical runtime schema lives in code and should use a discriminated structured contract.

Conceptually, the client receives two result types.

### `lesson`

Represents a lesson that matches the requested topic/content.

Expected grounded data may include:

- course identity,
- module context,
- lesson identity/title/slug,
- derived module/lesson label,
- key points,
- concise grounded description,
- navigation target,
- ranking score or ranking metadata only if needed by the client.

### `video`

Represents a matched moment in a lesson video.

Expected grounded data may include:

- the associated lesson,
- course/module context,
- thumbnail/poster,
- relevant description,
- `startSeconds`,
- duration/clip metadata when real data exists,
- lesson navigation target with start-time behavior.

A raw `video` Sanity document is never a standalone user-facing result.

---

## 3. Responsibility split

Search has five distinct stages.

### 3.1 Query interpretation — LLM

The LLM may:

- interpret user intent,
- identify concepts and useful keyword variants,
- construct or guide grounded retrieval through the Context MCP.

The LLM must not invent content or directly become the final ranking authority.

### 3.2 Candidate retrieval — GROQ / MCP

Retrieval fetches grounded candidates from Sanity.

Retrieve only the fields needed for matching/ranking/result construction.

Never retrieve entire transcript arrays for routine search.

### 3.3 Ranking — server application code

**Deterministic server-side ranking is the final ranking authority.**

The LLM may help interpret the query, but final ordering should be reproducible from grounded candidate data and server ranking rules.

This separation makes search testable and debuggable.

### 3.4 Validation — Zod

Every structured search response crossing the server/client boundary must pass the canonical runtime schema.

Never send unvalidated model-generated structures to the UI.

### 3.5 Presentation — client

The search page renders structured result cards.

The UI does not depend on conversational Markdown prose.

---

## 4. Retrieval strategy

Search both:

1. lesson-level topic/content,
2. video moments associated with lessons.

Merge grounded candidates before final ranking.

### Lesson retrieval

Match relevant lesson fields such as:

- title,
- key points,
- other structured topic fields,
- lesson notes through a plain-text projection where required.

Portable Text blocks are structured data; do not assume direct text-match behavior over raw block arrays.

### Video retrieval

Use a two-stage strategy:

1. search chapter labels first,
2. if no useful chapter match exists for the relevant video, search bounded transcript chunks as fallback.

Chapter labels are cleaner semantic anchors. Transcript text is noisier and should be the backstop.

---

## 5. Matching rules

For keyword-style text retrieval:

- derive meaningful search terms,
- wildcard terms where appropriate,
- OR useful terms rather than treating an entire natural-language query as one exact literal pattern,
- normalize matching consistently,
- avoid relying on case-sensitive behavior unless intentionally required.

Do not over-expand keywords to the point that broad noise dominates specific matches.

---

## 6. Ranking rules

Prefer specificity.

A practical ranking model should make the following relationship true:

```text
strong exact/specific title or topic match
    >
clean chapter match
    >
strong structured lesson-content match
    >
transcript fallback match
    >
broad/noisy keyword hit
```

Exact weights belong in application code and tests.

Ranking should consider enough signals to distinguish precise concept matches from generic shared vocabulary.

Deduplicate before final ordering.

---

## 7. Video-result grounding

A video moment is valid only when all required relationships resolve.

It must be tied to:

- a real video record,
- a real lesson that uses that video,
- the course/module context required by the UI,
- a real matched timestamp.

Never show a video document independently just because transcript text matched.

---

## 8. Transcript limits

Do not return whole transcripts to:

- the model,
- the search route response,
- the browser.

Retrieve a small bounded set of candidate chunks around relevant matches.

The purpose of transcript retrieval is to establish a grounded moment, not to place the entire source into the context window.

---

## 9. Counts and pagination

Do not arbitrarily restrict search to a handful of LLM-selected results.

Do not return an unbounded result set in one HTTP response.

Use bounded pagination or cursor-based pagination.

The API may expose:

- page results,
- grounded total/result count when it can be computed accurately,
- next cursor/page state.

Do not fabricate total counts.

---

## 10. Empty state

When nothing relevant is grounded:

- return an empty valid result set,
- do not invent an answer,
- let the UI guide the learner toward the broader course catalog.

---

## 11. Search Context document

The Sanity Context document allows search behavior to be tuned without changing application code.

It contains:

- content-scope configuration,
- concise search/query guidance.

Keep it focused on deltas the schema and runtime code do not already make obvious.

Do not duplicate the entire architecture into the Context document.

Critical grounding/retrieval rules that model behavior depends on should also exist in the inline system prompt because the inline prompt is generally the more reliable instruction surface.

---

## 12. Context caching

If the server caches initial Context configuration, changes may not affect the running process immediately.

When modifying:

- inline search prompt,
- Context document instructions,
- search configuration,

verify whether the current implementation requires a server restart or cache invalidation.

Do not treat stale cached instructions as a search-quality bug in the new configuration.

---

## 13. Semantic search fallback

Do not assume embeddings are available.

If `text::semanticSimilarity()` or equivalent semantic retrieval requires disabled/unconfigured embeddings:

- fall back to grounded keyword retrieval,
- do not silently enable paid/configuration-sensitive infrastructure.

Enabling embeddings is a separate product, architecture, and billing decision.

---

## 14. Failure handling

Search should have explicit behavior for:

- invalid model structured output,
- MCP/tool failure,
- malformed retrieval response,
- no results,
- unresolved video-to-lesson relationship,
- unavailable provider metadata.

Prefer a valid degraded response or clear error state over fabricated data.

---

## 15. Test expectations

Search changes should test or manually verify, as applicable:

- exact/specific lesson match outranks broad match,
- chapter match outranks transcript fallback,
- transcript fallback works when chapter match does not,
- video result resolves to the correct lesson,
- timestamp is real and preserved in navigation,
- duplicate results are removed,
- Zod rejects invalid response structures,
- empty search does not hallucinate,
- pagination is bounded,
- transcript payload is bounded,
- browser never receives private integration credentials.

For live MCP-dependent behavior, verify against the actual configured MCP endpoint when the environment allows it.
