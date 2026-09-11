# PR-0: Grounded AI contracts (extract from search)

## Goal

First increment of `docs/Vertex_AI_Native_Development_Plan.md` (§5 PR-0):
move the bounded model call, structured-output parsing, and safe diagnostics
out of `lib/search/` into a reusable `lib/ai/` layer, add the evidence
contracts later PRs consume, and bound the MCP path with timeouts — without
changing the `/api/search` response shape, ordering, empty states, or
400/502/500 semantics.

## Guidance read

- `AGENTS.md` §2, §9, §10, §12; `docs/ARCHITECTURE.md` §6, §10–12.
- Development plan §3 (inference and operations, evidence envelope), §5 PR-0,
  §6 release gates.
- Installed AI SDK 7 docs: `node_modules/ai/docs/03-ai-sdk-core/`
  `10-generating-structured-data.mdx`, `25-settings.mdx` (`timeout`,
  `maxRetries`), `55-testing.mdx` (`MockLanguageModelV4`).
- Installed type definitions: `@ai-sdk/mcp` (`initializationOptions`,
  `callTool({options: {timeout}})`), `posthog-node` (`secretKey`,
  `evaluateFlags`, `featureFlagsRequestTimeoutMs`).

## Code inspected

- `app/api/search/route.ts`, `lib/search/{search,interpret,mcp,retrieve,schema,terms,queries,rank}.ts`
  and their tests.
- `lib/posthog-server.ts`, `instrumentation-client.ts`, `proxy.ts`,
  `sanity/lib/{client,fetch}.ts`, `.env.example`, `package.json`.
- Lesson page PostHog pattern: `distinctId: userId ?? "anonymous"`.

## Decisions and assumptions

- User decisions (2026-09-11): Supabase for Postgres (PR-4), PostHog feature
  flags, sign-in required for tutor/practice/attempts. PR-0 touches neither
  Supabase nor sign-in: search stays public.
- `generateObject` is deprecated in AI SDK 7 and does not accept `timeout`;
  the gateway uses `generateText` + `Output.object()`.
- `posthog-node` `personalApiKey` and `isFeatureEnabled` are deprecated; use
  `secretKey` (env `POSTHOG_SECRET_KEY`) and `evaluateFlags`.
- Flag `ai-gateway-search`: on → interpretation goes through the gateway; off
  (default, and on any flag error) → today's direct call. This is the
  rollback switch. Evaluated only when an LLM call would happen (not on
  cursor pages or without `OPENAI_API_KEY`).
- No model-selects-IDs mode for search: the model already never chooses or
  orders results (AGENTS.md §9). The ID allowlist helper ships with PR-6, its
  first consumer.
- `lib/ai/gateway.ts` and `lib/ai/contracts.ts` stay framework-free (no
  env reads, no credentials, model injected) so `node --test` can load them,
  matching `rank.ts`/`terms.ts`. `server-only` remains on the modules that
  create providers or read secrets.
- To unit-test `retrieve.ts` (which keeps `server-only`), the test script adds
  `--conditions=react-server` and `retrieve.ts` imports `provider.ts` by
  relative path like other tested modules.
- Rate limiting is deferred to PR-4 (needs a shared store: Supabase).

## Expected files

- `lib/ai/gateway.ts` (new), `lib/ai/gateway.test.ts` (new)
- `lib/ai/contracts.ts` (new), `lib/ai/contracts.test.ts` (new)
- `lib/flags.ts` (new), `lib/timeouts.ts` + `lib/timeouts.test.ts` (new)
- `lib/search/interpret.ts`, `lib/search/search.ts`, `app/api/search/route.ts`
- `lib/search/mcp.ts`, `lib/search/retrieve.ts`, `lib/search/retrieve.test.ts` (new)
- `lib/posthog-server.ts`, `.env.example`, `package.json` (test script)

## Requirements

1. Gateway: `generateBoundedObject({model, schema, system, prompt, maxOutputTokens, timeoutMs, versions})`
   with at most one provider retry, a timeout, and typed failures
   `timeout | provider_error | invalid_output` (`AiCallError`).
2. Diagnostics per call: task, prompt version, model id, status, latency,
   input/output tokens. Never raw prompt, query, or output text.
3. Contracts: Zod `evidenceRefSchema`, `resolvedCitationSchema`,
   `supportedFeedbackSchema` with bounded lengths/counts; citation `href`
   is an internal `/lessons/<slug>[?t=<seconds>]` path; `endSeconds >= startSeconds`.
   No generation logic.
4. Flags: `isFlagEnabled(key, distinctId)` fails closed on missing config,
   errors, or timeouts.
5. MCP: connect and per-`groq_query` timeouts raise `SearchUnavailableError` (502).
   Timeout degradation (partial results instead of 502) is a follow-up, not
   part of PR-0's behaviour contract.
8. Timeouts live in `lib/timeouts.ts`: `AI_GATEWAY_TIMEOUT_MS` (default
   10000) and `MCP_TIMEOUT_MS` (default 8000, connect and each query), each
   overridable by the same-named env var within 1000–60000 ms (revised
   2026-09-11 after live runs showed ~7 s interpretation against an 8 s bound).
6. Retrieval: top-level rows whose `_id` is a draft (`drafts.`) or release
   version (`versions.`) are dropped.
7. Interpretation keeps its deterministic fallback on every failure.

## Security

- No new browser-exposed values; `POSTHOG_SECRET_KEY` is server-only.
- Diagnostics exclude learner text (plan §3).
- Draft/version guard is defence in depth; the MCP's perspective is still
  unverified until the Studio is deployed.

## Acceptance criteria

- `/api/search` responses are unchanged in shape, order, and error codes.
- Gateway tests cover valid output, invalid output, provider error with a
  bounded retry count, timeout, and diagnostics without raw text.
- Retrieval tests cover draft IDs, invalid timestamps, and videos with no lesson.
- Flag off or unavailable → existing interpretation path runs.

## Checks

`npm run typecheck`, `npm run lint`, `npm test` (Node ≥ 22), `npm run build`.

## Manual tests

1. `npm run dev`, open `/search?q=react+hooks`: results (or the existing
   502 message while the Studio is undeployed) render as before.
2. In PostHog, create flag `ai-gateway-search` (off). Search works; server log
   shows no `[ai]` line. Turn it on: server log shows one `[ai]` diagnostics
   line per new search, with no query text.
3. Unset `OPENAI_API_KEY`: search falls back to keyword terms, no flag call.

## Rollback

Turn `ai-gateway-search` off (or leave it undefined). MCP timeouts and the
draft guard are revertible by commit; no content migration.
