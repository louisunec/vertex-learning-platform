# AI-proposed prerequisite edges on the Knowledge Map

Status: implemented 2026-09-14. The user explicitly waived review ("Proceed through implementation… Do not stop for individual edge approvals"). This file is the record, not an approval request.

## Goal

For every course with published concepts:

- generate prerequisite proposals from lesson evidence with the existing PR-3 pipeline;
- save them idempotently as unreviewed drafts with provenance;
- show them on the Knowledge Map as dashed "AI-proposed relationships" for the presentation account only.

Nothing may mark a proposal reviewed or let it affect gating, mastery, or next actions.

## Guidance and code read

- `AGENTS.md` and the memory notes: knowledge-map, live-content-state, context-mcp-live-scope, local-toolchain-gotchas, preview-fails-closed-under-load.
- **Pipeline:** `scripts/generate-concepts.mts` (`prerequisites`), `lib/concepts/prerequisites.ts` (`planEdges`, prompt, ids, suppression), `lib/concepts/pipeline.ts` (`proposePrerequisites`), `lib/concepts/graph.ts` (`findCycles`, `validateGraph`).
- **Schema:** `studio/schemaTypes/documents/concept-prerequisite.ts`.
- **Map:** `app/my-learning/knowledge-map/page.tsx`, `lib/knowledge-map.ts`, `components/my-learning/knowledge-map/*`, `sanity/queries/my-learning.ts`, `sanity/data/my-learning.ts`, `sanity/lib/client.ts`.
- **Graph consumers:** `sanity/queries/next-action.ts` (`NEXT_ACTION_EDGES_QUERY`). Mastery (`lib/learner/*`) doesn't read edges.

## Decisions

1. **Reuse, don't extend, the generator.** `generate:concepts -- prerequisites --course <slug>` already covers the validation the user asked for:
   - one bounded call per course over published, approved concepts, with 1 evidence chunk each;
   - validation of indices, self-edges, evidence from both endpoints, duplicates, both-direction conflicts, already-published pairs, rejected-edge suppression, and editor-modified drafts;
   - cycle reporting;
   - deterministic ids, a content hash, and a per-course generation record, so a rerun makes 0 model calls.

   Its proposals are `drafts.concept-prereq-*` with `status: "proposed"` and a `generation` block (model, prompt/config versions, key, suppression key, content hash, generatedAt).
2. **Writes use the Studio CLI session.**
   - `SANITY_API_WRITE_TOKEN` is unset, and memory rules out using the Editor-grade read token for content writes.
   - The generator ran with `--dry-run --out`. A one-off, uncommitted writer (session scratchpad) applied exactly those planned transactions through `sanity exec --with-user-token`.
   - It wrote `createIfNotExists` only, in one transaction per course, after these guards: only proposed/current edge drafts plus the `course_prerequisites` record; no `review` block; no existing target with other content; no published edge for the pair in either direction.
3. **Proposals stay drafts.**
   - Publishing them would put them in the graph's document space, and the generator treats published pairs as `already_published`.
   - Every graph consumer reads published, approved edges only, so gating, mastery, and next-action exclusion needs no new code. `drawableEdges` also ignores non-approved rows; there's a test for that.
4. **The display option is an env allowlist, `KNOWLEDGE_MAP_PROPOSED_EDGES_USER_IDS`** (server-only, comma-separated Clerk ids, off when empty). PostHog flags can't be created with our `phs_` key. The preview lists the user's dev Clerk id only.
5. **Draft read.**
   - The new `KNOWLEDGE_MAP_PROPOSED_EDGES_QUERY` reads `drafts.**`, `status == "proposed"`, `sourceStatus == "current"`, with both endpoints on the map.
   - It goes through `draftReadClient` (`perspective: 'raw'`, no CDN, uncached) and runs only when the viewer is allowlisted.
   - A failure there doesn't fail the map. The legend says the proposals couldn't be loaded.
6. **Display validation** (`displayableProposedEdges`): drop off-map, self, and null endpoints; pairs the approved graph already relates in either direction; repeats (the first by id wins); and every proposal inside a cycle with the approved edges plus the other proposals.
7. **UI.**
   - Approved edges keep the solid neutral arrow.
   - Proposals are dashed, in violet (`text-lesson`, a colour no learner state uses).
   - Each arrow has a 14px transparent twin as a keyboard-focusable `role="button"` click target.
   - Selecting one opens a panel under the map: its kind, "From → To", the rationale, up to 2 source moments as "Lesson N · mm:ss" deep links (`?t=`), and, for proposals, "Suggested by AI from lesson evidence. It isn't used for your recommendations or progress unless the course team approves it."
   - When proposals are shown, the legend swaps "Arrows show prerequisites" for two line samples: "Prerequisite, reviewed by the course team" and "AI-proposed relationships · not reviewed, not used for recommendations".
   - Screen-reader node descriptions list approved and proposed prerequisites separately.
   - The approved-edge query now also projects `rationale` and `evidence`, so approved arrows open the same panel.
8. **Branch.** `feat/knowledge-map-proposed-edges` off `feat/knowledge-map` (`ff37283`, PR #15), merged into the local-only `preview/my-learning` for :3000.

## Generation results (v4lee87n/production, 2026-09-14)

| Course | Published concepts | Proposed edges | Validator rejections | Cycles |
|---|---|---|---|---|
| Building AI Apps with LLMs | 5 | 4 | 0 | 0 |
| Practical Web Security | 7 | 6 | 0 | 0 |
| 8 other courses | 0 | skipped (no published concepts) | — | — |

**Building AI Apps with LLMs** (gpt-5-mini, `concept-prerequisites-v1`), all from Autoregressive text generation:
- → Greedy decoding
- → Sampling temperature
- → Top-k sampling
- → Top-p sampling

**Practical Web Security:**
- Authentication vs authorization → Authorization
- Authentication vs authorization → Authentication methods
- Authentication vs authorization → JSON Web Tokens
- Authentication vs authorization → Server-side sessions
- Authorization → Principle of least privilege
- Principle of least privilege → Privileged account management

**Omitted.** No proposal was rejected by validation. The model left these pairs unconnected, which fits the rule that similarity or course order isn't a prerequisite and that transitive edges are skipped:
- the four decoding and sampling strategies with each other;
- JWT ↔ server-side sessions (alternatives);
- authentication methods ↔ JWT / sessions;
- authorization → privileged account management (transitive through least privilege).

Reruns: both courses report "skipped: already proposed for these concepts and prompt; 0 model call(s)". `validate:concepts` finds no graph defects and 0 published edges.

## Security

- The drafts are read server-side only, with the existing read token, for allowlisted ids only.
- The browser gets names, rationale, and lesson links, and never ids of other drafts.
- No write path is added.

## Checks

- `npm test` (no DB), `npm run typecheck`, `npm run lint`, `npm run build` on the branch and on the preview after the merge.
- `lib/knowledge-map-query.test.ts` evaluates the real GROQ with groq-js over a mixed raw dataset.

## Manual test

1. Sign in on http://localhost:3000 as the presentation account, then open `/my-learning/knowledge-map?course=building-ai-apps-with-llms`.
2. Expect 4 dashed violet arrows from Autoregressive text generation and the legend "AI-proposed relationships".
3. Click an arrow: the panel shows the rationale and two "Lesson N · mm:ss" links that open the lesson at that second.
4. Practical Web Security appears in the course select only once the account has progress in one of its lessons.
5. Signed in as any other account, the map shows no dashed arrows and the legend is unchanged.
