# Intelligent search: Context MCP + search API + results page

## Goal

Implement Vertex intelligent search end to end:

1. connect the Sanity Context MCP as the server-side grounded retrieval path,
2. add the server search API (`/api/search`) implementing the five-stage split
   (LLM interpretation → GROQ/MCP retrieval → deterministic server ranking →
   Zod validation → structured client presentation),
3. add the `/search` results page rendering `lesson` and `video` result cards
   over courses and lessons, with video results deep-linking to
   `/lessons/<slug>?t=<seconds>`.

## Guidance read

- `AGENTS.md` §2, §9, §10; `docs/SEARCH.md`; `docs/ARCHITECTURE.md` §6, §10–12.
- Skill `create-agent-with-sanity-context` (+ `references/nextjs-agent.md`,
  `references/studio-setup.md` deploy notes).
- Installed Next.js docs: route handler conventions
  (`node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`).

## Code inspected

- `sanity/lib/client.ts`, `sanity/lib/fetch.ts`, `sanity/queries/*`,
  `sanity/data/*` — server-only read pattern, fragments, cache tags.
- `app/lessons/[slug]/page.tsx` — `?t=<seconds>` deep link already wins over
  resume position; `lib/video/embed.ts` + `lib/video/provider.ts` provide
  `toStartSeconds`, `getEmbedSource`, `parseVideoUrl` (stable `videoId`).
- `studio/sanity.config.ts` — `contextPlugin({insights: {enabled: false}})`
  already registered (`@sanity/context` 0.7.1, Sanity v5).
- `studio/node_modules/@sanity/context/.../contextSchema.ts` — verified
  `sanity.agentContext` fields: `version`, `name`, `slug` (slug), `groqFilter`
  (string), `instructions` (text).
- `components/home/hero-search-form.tsx` — home form already GETs `/search?q=`.
- Live check: the Context MCP endpoint currently returns
  “Only datasets with deployed Studio applications are supported” — the Studio
  is **not deployed yet** (operational prerequisite, see below).

## Decisions and assumptions

- **Responsibility split (per SEARCH.md):** the LLM only interprets the query
  into bounded concepts/keywords (`generateObject` + Zod). The server builds
  canonical GROQ candidate queries from those sanitized terms and executes them
  **through the MCP `groq_query` tool** (slug-scoped endpoint, so the Context
  document's `groqFilter` scoping applies). The LLM never authors free-form
  GROQ and never orders final results — ranking is pure server code.
- **Context document instructions reach the model via the interpretation
  system prompt**: the server reads the `sanity.agentContext` document's
  `instructions` by slug with the existing server read client (cached ~60s via
  `sanityFetch`) and appends it to the inline system prompt. (Tool-description
  injection never reaches a model when server code calls tools directly.)
  Critical grounding rules stay inline in code as the primary surface.
- **Keyword safety / no GROQ injection:** interpreted terms are sanitized to
  lowercase `[a-z0-9-]` tokens (≤ 12 terms, ≤ 32 chars each) before being
  inlined as `field match "term*"` OR-chains. GROQ `match` with an array RHS is
  AND, so OR-chains are built explicitly. No dependence on a `params` argument
  in `groq_query` (its input schema can't be verified until the Studio is
  deployed; a self-contained query string works either way).
- **LLM provider/model:** Vercel AI SDK + `@ai-sdk/openai`, `gpt-5-mini` for
  query interpretation (small, fast task; the user's provider is OpenAI).
  On LLM failure or missing `OPENAI_API_KEY`, fall back to a deterministic
  stopword tokenizer — degraded interpretation, retrieval stays grounded.
- **Course coverage ("over courses and lessons"):** a course whose
  title/summary/outcomes match contributes its lessons as broad-tier lesson
  candidates (course itself is not a result type; the contract is
  `lesson` | `video`).
- **Video→lesson grounding:** the video candidate query subquery-joins lessons
  by `videoUrl match` on the provider id; server code then verifies
  `parseVideoUrl(lesson.videoUrl)?.videoId === video.videoId` and drops any
  moment that does not resolve to a real lesson (SEARCH.md §7). Bunny's
  `libraryId/guid` id is handled by matching on the guid segment.
- **Transcript bounds:** the query filters `transcriptChunks` by term match and
  slices to ≤ 6 chunks per candidate video; chapters are matched first and
  transcript matches are used only when no chapter matched for that video.
- **Pagination without re-calling the LLM:** cursor = base64url JSON
  `{v, terms, offset}`, Zod-validated with the same term bounds. First request
  interprets; “Show more” passes the cursor back. `total` is the grounded count
  of the ranked, deduplicated result set. Page size 10 (max 20).
- **Search stays public** (browsing is public; search is not marked protected).
  Route responses are `no-store`.
- **MCP client lifecycle:** created per request via `createMCPClient` (HTTP
  transport, `Authorization: Bearer SANITY_API_READ_TOKEN`), closed in
  `finally`. URL built from existing Sanity env + optional
  `SANITY_CONTEXT_SLUG` (blank ⇒ base URL so search works before the Context
  document exists).
- No embeddings / `text::semanticSimilarity()` — keyword retrieval only
  (embeddings are a separate billing decision).
- No search reference image exists → cards follow existing catalog/lesson card
  styling with `components/ui` primitives; smallest sensible layout.

## Expected files

**Web (new):**

- `lib/search/schema.ts` — canonical Zod contract: discriminated
  `searchResultSchema` (`type: 'lesson' | 'video'`), `searchResponseSchema`
  (`results`, `total`, `nextCursor`, `query`), cursor schema. Lesson result:
  lesson identity/slug/duration/posterUrl, course identity + derived
  module/lesson label, key points, grounded description, `href`. Video result:
  the same lesson/course context plus `startSeconds`, matched chapter label or
  transcript snippet, `href` with `?t=`.
- `lib/search/terms.ts` — tokenizer, stopwords, sanitization, fallback
  interpretation (pure).
- `lib/search/interpret.ts` — server-only `generateObject` interpretation with
  inline system prompt (critical grounding/retrieval rules, escaped backticks)
  + Context instructions + small grounded vocabulary (course/category titles).
- `lib/search/queries.ts` — GROQ candidate query builders from sanitized terms
  (lesson, video+moments, course→lessons), minimal projections, reverse
  course reference like `LESSON_BY_SLUG_QUERY`.
- `lib/search/mcp.ts` — MCP client factory + `groq_query` executor with
  defensive content-block parsing (JSON string or object).
- `lib/search/retrieve.ts` — run candidate queries via MCP, lenient per-row Zod
  parse (drop invalid rows), video→lesson grounding check.
- `lib/search/rank.ts` — pure deterministic scoring per SEARCH.md §6 tiers
  (title/topic > chapter > structured content > transcript > broad), term
  overlap + phrase bonus, dedup per type, stable tie-breaks, pagination.
- `lib/search/search.ts` — orchestrator; validates the final response against
  the canonical schema before returning.
- `lib/search/rank.test.ts`, `lib/search/terms.test.ts` — node:test units for
  the SEARCH.md §15 ranking expectations.
- `app/api/search/route.ts` — GET `?q=&cursor=`; explicit failure paths:
  LLM fail → fallback terms; MCP fail → 502 error body; invalid final
  structure → 500; empty → valid empty response.
- `app/search/page.tsx` — server shell (SiteHeader, pre-filled search form
  GETting `/search`) + client results component.
- `components/search/search-results.tsx` — client; fetches `/api/search`,
  renders cards, Show more, empty state (link to `/courses`), error state,
  PostHog `search_results_viewed` (`query_length`, `result_count` — no query
  text, matching the existing event's privacy pattern).
- `components/search/lesson-result-card.tsx`,
  `components/search/video-result-card.tsx`.

**Web (modified):**

- `package.json` — add `ai`, `@ai-sdk/openai`, `@ai-sdk/mcp`, `zod`
  (latest versions via `npm info`).
- `.env.example` — add `OPENAI_API_KEY`, `SANITY_CONTEXT_SLUG`
  (default `vertex-search`); note `SANITY_API_READ_TOKEN` is required for
  search (MCP Bearer auth).

**Studio (new/modified):**

- `studio/scripts/context/search-context.ndjson` — one `sanity.agentContext`
  document: `_id: agentContext-vertex-search`, name “Vertex Search”, slug
  `vertex-search`, `groqFilter: '_type in ["course","lesson","video","instructor","category"]'`
  (excludes `progress` — learner PII never enters the search path),
  `instructions`: concise search deltas (lesson↔course is a reverse reference;
  video docs are internal lookup records; chapters before transcript chunks;
  notes are Portable Text — use `pt::text()`).
- `studio/package.json` — `context:import` script
  (`sanity dataset import scripts/context/search-context.ndjson --replace`).

## Security

- MCP URL, Bearer token, and Anthropic key are server-only (`server-only`
  imports; no `NEXT_PUBLIC_` for secrets). Browser only ever receives the
  Zod-validated structured response.
- Sanitized-token query building makes GROQ injection via search input
  impossible; cursor input is Zod-bounded.
- `progress` documents are excluded from the Context scope and from every
  candidate query.

## Acceptance criteria

- `/search?q=...` renders grounded lesson and video cards; video cards link to
  `/lessons/<slug>?t=<seconds>` and the embed starts at that second.
- Specific title matches outrank broad hits; chapter matches outrank
  transcript fallbacks; transcript fallback fires only without a chapter match
  (unit-tested in `rank.test.ts`).
- Duplicates removed; unresolved video→lesson moments dropped; no whole
  transcript in any request-path payload (≤ 6 filtered chunks per video).
- Invalid model output or MCP failure produces the explicit degraded/error
  path, never fabricated results; empty search returns a valid empty set.
- Pagination bounded; `total` grounded; “Show more” does not re-call the LLM.

## Checks

- Web: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`.
- Live (needs env + deployed Studio): dev server manual search; verify MCP
  tools respond, `?t=` seek works per provider, transcript payload bounded.

## Manual tests

1. `npm --prefix studio run context:import` (after Studio deploy) — creates the
   Context document; open Studio → Sanity Context → “Vertex Search”.
2. `npm run dev`, open `/`, submit a query from the hero form → lands on
   `/search?q=...` with results.
3. `curl -s 'http://localhost:3000/api/search?q=<topic>'` — validated JSON,
   `results[].type ∈ {lesson, video}`, bounded page, grounded `total`.
4. Click a video result → lesson page video starts at the matched second.
5. Search gibberish (`zzqqxx`) → empty state with catalog link, no invented
   results.
6. Edit the Context document instructions → confirm the documented behavior
   (picked up within ~60s cache window; restart if cached longer).

## Needs your attention (before live verification works)

- **The Studio must be deployed** (`npx sanity deploy` in `studio/`, choose a
  hostname; requires Sanity CLI auth). The MCP endpoint verifiably rejects
  requests today because no deployed Studio exists. Schema deploy alone is not
  enough.
- `OPENAI_API_KEY` must be added to `.env.local` (search still runs with
  the tokenizer fallback without it).
- `groq_query`'s exact input schema can only be confirmed against the live
  endpoint post-deploy; the implementation is written to not depend on
  anything beyond `{query}`.
