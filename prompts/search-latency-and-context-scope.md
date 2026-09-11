# Search latency fix and Context scope (follow-up to PR-0)

## Goal

Make search interpretation finish reliably within the 10 s AI-gateway bound
without changing the model, prompt contract, schema, sanitization, fallback,
or the public `/api/search` response; and restore course context by widening
the published `vertex-search` Context `groqFilter`.

## Decisions (user, 2026-09-11)

- Keep `AI_GATEWAY_TIMEOUT_MS` at 10 s; do not switch models unless the
  lower-effort configuration fails the latency target (it did not).
- Lowest reasoning effort supported by the installed SDK and API; smallest
  reliable output budget.
- Context `groqFilter`: `_type in ["course", "lesson", "video", "instructor", "category"]`.
- PostHog experience continuity stays a manual follow-up.
- Separate commit from PR-0 (`aa662ea`) and the uncommitted dark-theme work.

## Changes

- `lib/ai/gateway.ts`: optional `providerOptions` passed through to `generateText`.
- `lib/search/interpret.ts` (gateway path only): `reasoningEffort: 'minimal'`,
  `reasoningSummary: null` (the provider otherwise defaults summaries to
  `detailed` when an effort is set), `maxOutputTokens` 1000 → 96. The
  flag-off rollback path keeps default effort and 1000 tokens, which its
  reasoning tokens need.
- Published Sanity document `cb53c252-4e89-4470-bb7e-00ef49da46cc`
  (`sanity.agentContext`, slug `vertex-search`): `groqFilter` updated via the
  CLI user session with a revision guard. **Rollback value:**
  `_type in ["video", "lesson"]`.

## Evidence

Reasoning effort (installed `@ai-sdk/openai` 4.0.62 lists
`none | minimal | low | medium | high | xhigh | max`): the API rejects `none`
for `gpt-5-mini` ("Supported values are: 'minimal', 'low', 'medium', and
'high'"), so `minimal` is the lowest.

Output budget: 81 live `minimal` calls, all valid; output tokens p50 44,
p95 62, max 66; reasoning tokens always 0. Budgets 64/96/128 each returned
20/20 valid on 16 representative + 4 stress queries, but 64 sits below the
observed maximum (1 of 81 calls would have truncated). 96 leaves ~45% headroom;
a later run reached 67. Truncation fails schema validation and falls back.

Full-pipeline benchmark, 16 representative queries, same Context scope,
production build, sequential, warm-up excluded:

| Metric | Before (default effort, 1000) | After (minimal, 96) |
| --- | --- | --- |
| Valid structured output | 5/16 | 16/16 |
| Model latency p50 / p95 / max | 10,008 / 10,020 / 10,020 ms | 1,949 / 5,863 / 5,863 ms |
| Timeouts → keyword fallback | 11 | 0 |
| Output tokens p50 / max (valid calls) | 430 / 504 | 40 / 66 |
| Input tokens p50 | 376 | 376 |
| Server total p50 / max | 14,039 / 16,572 ms | 5,627 / 9,556 ms |
| Client end-to-end p50 / max | 14.06 / 16.59 s | 5.64 / 9.56 s |

Result differences: 7/16 identical totals, 5/16 identical top-10 order. The 11
queries that timed out before now use model terms instead of fallback terms
(e.g. `deployment` 1 → 10 terms, 15 → 32 results). Of the 5 queries valid in
both runs, 3 were identical; `unit testing` (22 → 28, top-10 overlap 3/10) and
`data fetching` (75 → 89, 8/10) changed with the model's keyword variants.

Context scope verification (temporary probe documents, deleted afterwards):

| Source | Draft lesson probe | Published `progress` probe | Version docs | Courses |
| --- | --- | --- | --- | --- |
| Dataset (raw) | 1 | 1 | 0 | 10 |
| Scoped MCP (`vertex-search`) | 0 | 0 | 0 | 10 |
| Unscoped MCP | 0 | 1 | 0 | 10 |

The MCP reports `perspective: "published"`; `groq_query` accepts only
`query`, so callers cannot choose a perspective. Release versions could not be
probed without creating a content release (dataset has none). Live search
after the change: 14/16 HTTP 200, all 14 with course context (3–10 courses),
0/133 page results without a course, 0 draft/version ids. The two 502s were
MCP transport failures (one 8 s `groq_query` timeout, one `terminated`); both
queries passed 3/3 on retry, and each retrieval query measured 0.5–1.7 s alone.

## Follow-ups

- PostHog: turn off "Persist flag across authentication steps" for
  `ai-gateway-search` (manual; the project secret key cannot edit flags).
  Until then every flag check is a remote request (~0.7 s p50).
- Keep `SANITY_CONTEXT_SLUG=vertex-search` set in every environment: the
  unscoped MCP endpoint returns `progress` documents.
- MCP timeout degradation (partial results instead of 502) remains a
  follow-up outside PR-0's contract.

## Checks

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build` (Node ≥ 22).
