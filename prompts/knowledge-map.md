# Knowledge map tab (My Learning)

Status: **approved 2026-09-13.** The user chose D2 = show the reason, D3 = the 30-day rule as written, and D4 = the `knowledge-map-test` dataset plus local DB rows, deleted afterwards.

## Goal

Build the **Knowledge map** tab under My Learning from `design/vertex-knowledgemap.jpg`:
- Nodes come from the published, reviewed Sanity concept graph (PR-3 `concept` + `conceptPrerequisite`).
- Each node shows the signed-in learner's state from PR-4 evidence (Postgres).
- Selecting a node opens the right-hand evidence panel, whose source links deep-link to the exact second in the lesson (`/lessons/<slug>?t=<seconds>`).

## Guidance read

- `AGENTS.md`: §4 (the reference image is the source of truth), §7 (numbers derived from order), §11.
- The project `CLAUDE.md` approval gate.
- `docs/Vertex_AI_Native_Development_Plan.md`:
  - missing evidence is unknown;
  - the estimate is uncalibrated and never a gate;
  - distinguish unknown, practiced with help, and independent evidence;
  - every increment ships behind a disabled flag.
- Memory: #14 is unmerged; the live dataset has 0 concepts, 0 edges, and 0 assessments (re-checked 2026-09-13); never seed production.

## Code inspected (in `../vertex-my-learning`, PR #14 @ a807055)

- `app/my-learning/page.tsx`: the overview, the `readEvidence` flag/DB states, `settle()`, and `SignedOut`.
- `components/my-learning/learning-tabs.tsx`: Knowledge map is currently a disabled span.
- `studio/schemaTypes/documents/concept.ts`: `conceptId`, `name`, `summary`, `lessons[]`, `sourceRefs[]`, `reviewStatus`, `sourceStatus`, and the merge/split tombstones.
- `studio/schemaTypes/documents/concept-prerequisite.ts`: `prerequisite`/`dependent` refs; only approved and published edges count.
- `studio/schemaTypes/objects/concept-source-ref.ts`: `chunkId`, `startSeconds`, `endSeconds`, `lesson`.
- `lib/concepts/graph.ts`: `validateGraph`. Its comment says a consumer must read only a validated graph.
- `lib/concepts/resolve.ts`: `resolveConcept` (merges and splits).
- `db/migrations/0001_learner_evidence.sql`:
  - `learner.concept_mastery`: counts plus `evidence_status` of `unknown | assisted_only | independent`;
  - `learner.attempt_log`: `correct`, `evidence_kind`, `evidence_reason`, `resolved_concept_id`, `assessment_id`, `assessment_version`, `selected_option_id`, `created_at`;
  - RLS through `asLearner`.
- `lib/learner/evidence.ts`, which holds the policy, and `lib/learner/overview.ts`, the pattern for a bounded `asLearner` read.
- `lib/learner/contracts.ts`: no learner response contains `answerKey` reasons (see D2).
- `sanity/queries/my-learning.ts`:
  - `MY_LEARNING_COURSES_QUERY`, which gives ordered modules → lessons for numbering;
  - `CONCEPT_IDS_FOR_LESSONS_QUERY`, which has the learner-read filter.
- `lib/my-learning.ts`: `pickActiveCourse`, `countConceptsWithEvidence`.
- `lib/format.ts`: `formatClock`, `formatRelativeTime`.
- `lib/search/rank.ts:113`: the `?t=` deep-link pattern.
- `app/lessons/[slug]/page.tsx`: `?t=` beats the stored resume position.
- `components/ui`: `Card`, `Button`, `Badge`, `Icon`, `Select`.
- `lib/flags.ts`.

## Where

- A new worktree, `../vertex-knowledge-map`, on branch `feat/knowledge-map`, off `feat/my-learning-overview` (#14, a807055). This is the same base PR-7 used.
- It is not the main checkout, which is on PR-3 with dirty theme files.
- It is not `../vertex-pr-7`, which holds uncommitted work.
- PR-7 also edits `lib/flags.ts` and `sanity.types.ts`, so expect a small merge later.
- Setup: `npm ci` (root and `studio/`), copy `.env.local` and `studio/.env` from `../vertex-my-learning`, then `npm run typegen`.

## Decisions (defaults; D2–D4 need your answer)

**D1: Route and selection.**
- `/my-learning/knowledge-map?course=<slug>&concept=<cpt-id>` is a server-rendered page.
- A node is a `<Link scroll={false}>` to the same page with `?concept=`, so the panel's private reads stay on the server. There is no new API route.
- Both params are validated against sets the server derives, and ignored otherwise.
- The default selection is the first "Needs practice" node in map order, otherwise the first node.

**D2: Per-attempt sentence (open).**
- The design's lines "Mixed up logits and probabilities" and "Chose the correct loss function" are the reviewed `answerKey.distractorReasons[selected].reason` and `answerKey.correctReason`. No learner surface shows them today.
- Recommended: show the reason for the option the learner chose, for their own attempts only, when the attempted assessment version is still published. The server selects just that one string and never sends the key.
- This can't manufacture evidence: any later attempt on the same family counts as `repeat_task` → `not_counted`.
- Alternative: omit the line.

**D3: State mapping (open).** `lib/knowledge-map.ts`, pure and unit-tested. Rows are first resolved through merges; split concepts count as not assessed.
- **Not assessed**: no counted evidence (`unknown`, or no row).
- **Needs practice**:
  - the latest independent attempt was incorrect; or
  - the evidence is assisted-only with no correct attempt.
- **Developing**:
  - the evidence is assisted-only with at least one correct attempt; or
  - the latest independent attempt was correct but more than 30 days ago.
- **Recent evidence**: the latest independent attempt was correct within 30 days (`RECENT_EVIDENCE_DAYS = 30`).
- The design's own example (independent wrong, then correct with a hint) maps to Needs practice.
- The numeric `estimate` is never shown.

**D4: Visual verification data (open).**
- Live content has no concepts, so a real flow shows only the empty state.
- Recommended: create a separate Sanity dataset `knowledge-map-test` with a small fixture graph (6 concepts, 5 edges, the design's shape), plus local embedded-Postgres attempt rows for one throwaway Clerk test user. Delete them afterwards.
- Alternative: verify with unit/DB tests plus the empty state only.

**D5: Layout.**
- A 3-column grid in course-teaching order: the earliest source lesson's position in the course, then `startSeconds`, then name.
- This reproduces the reference, which is in course order, not longest-path layers.
- SVG edges:
  - a straight arrow between adjacent nodes in the same row;
  - otherwise a curve from the bottom of the source to the top of the target (or top to bottom when the target is in an earlier row).
- Zoom − / % / + is a client-side CSS scale, in steps from 50% to 150%.
- On narrow screens the canvas scrolls horizontally inside its own container.

**D6: Controls the design shows but that have no backend.**
- The Goal dropdown is omitted, because the goal model is PR-11.
- "Practise this concept" is rendered disabled, labelled "Coming soon". This matches the existing "shown disabled, never linked" pattern; PR-7's check is uncommitted.
- "View attempt →" is omitted, because no attempt page exists.
- The Reviews tab stays disabled.

**D7: Course selector.**
- It lists the learner's courses (progress lessons → `getCoursesContainingLessons`).
- The default is `pickActiveCourse`, otherwise the first course.
- Changing it navigates with `?course=`.

**D8: Flag.**
- A new PostHog flag, `knowledge-map`, which also requires `learner-evidence`.
- With either flag off, the tab stays disabled and the route returns `notFound()`.
- The overview page evaluates the flag to decide whether the tab is a link.

**D9: Analytics.** No new PostHog events, which avoids sending learner-state data to analytics.

## Requirements

1. **Graph read** (Sanity, server-only, bounded):
   - Nodes: published concepts that are `approved` and `current`, where `lessons[]` intersects the course's lessons (`[0...100]`). Project `_id`, `conceptId`, `name`, `summary`, and `sourceRefs[lesson._ref in $lessonIds]{lesson._ref, startSeconds}` (capped).
   - Edges: published `conceptPrerequisite`s that are `approved` and `current`, with both endpoints among those node ids (`[0...300]`).
   - Run `validateGraph`, drop every edge named in a defect, and log the drop on the server.
2. **Evidence read** (`lib/learner/knowledge-map.ts`, `asLearner`, bounded, ids and enums only):
   - the learner's `concept_mastery` rows (≤500);
   - the latest independent attempt per `resolved_concept_id` (`distinct on`, ≤500);
   - both scoped, before the bound, to the map's concepts and those merged into them (`evidenceIdsFor`), so another course's evidence can't use up the limit;
   - for the selected concept, the 5 newest attempts (joined to `task_instance` for `lesson_id`).
   Everything is resolved through merges with `loadConceptIndex()`.
3. **Map card**:
   - Each node has a letter tile (the first letter of its name), the name, and a state label with the colour for its state. The selected node gets a ring and `aria-current`.
   - Each link's accessible name includes the state.
   - The arrow SVG is `aria-hidden`; each node with prerequisites is described (`aria-describedby`) by a visually hidden "Prerequisites: A, B." line.
   - The legend matches the design (4 states and their descriptions, plus "Arrows show prerequisites").
4. **Evidence panel**:
   - The tile, name, and state chip; the summary.
   - "Based on N attempts" (the counted independent + assisted totals), with "; more practice needed." added for Needs practice.
   - Attempt rows (up to 5): a ✕ or ✓ icon, a label from the reason (`Independent attempt`, `With a hint`, `Solution shown`, `Repeat attempt`), `· <relative time>`, the D2 line, and an `ASSISTED` or `NOT COUNTED` badge.
   - With no attempts: "No attempts on this concept yet."
5. **Related source**:
   - The concept's first source in course order: "Lesson {n} · {MM:SS}", then the lesson title, linking to `/lessons/<slug>?t=<floor(startSeconds)>`.
   - `n` is the lesson's 1-based position across the course's ordered modules.
   - MM:SS is zero-padded as in the reference: add a `{pad}` option to `formatClock`.
   - "View in course →" goes to `/courses/<slug>`. "Watch explanation" uses the same timestamp link.
   - With no source in this course, the section is omitted.
6. **Explicit states**, never shown as empty data:
   - signed out: the shared `SignedOut` card, moved to `components/my-learning/signed-out.tsx`;
   - `DATABASE_URL` unset;
   - evidence read failed;
   - Sanity read failed;
   - no courses yet (with a Browse courses link);
   - no reviewed concepts in this course (the current live state).
7. **Tabs**: `LearningTabs` takes `active` and `knowledgeMap`. Knowledge map becomes a real link with the active underline.

## Expected files

- New:
  - `app/my-learning/knowledge-map/page.tsx`
  - `components/my-learning/knowledge-map/{concept-map,evidence-panel,course-select,map-legend}.tsx`
  - `components/my-learning/signed-out.tsx`
  - `lib/knowledge-map.ts`, `lib/knowledge-map.test.ts`
  - `lib/learner/knowledge-map.ts`, `lib/learner/knowledge-map.db.test.ts`
- Modified:
  - `app/my-learning/page.tsx`
  - `components/my-learning/learning-tabs.tsx`
  - `sanity/queries/my-learning.ts`, `sanity/data/my-learning.ts`
  - `sanity.types.ts` (typegen)
  - `lib/flags.ts`
  - `lib/format.ts` (+ test)

## Security

- The learner id comes only from `auth()`, and every Postgres read goes through `asLearner` (RLS).
- `?course` and `?concept` are only selectors, checked against sets the server derives.
- No new route and no client fetch.
- The client components receive only names, states, positions, and hrefs.
- The answer key never leaves the server; D2 sends one reason string for the learner's own attempt.
- No production seeding.

## Acceptance criteria

- The desktop layout matches the reference in structure, spacing, colours, and states (except the D6 omissions).
- Clicking a node updates the panel without a full scroll jump.
- The source link opens the lesson at the exact second.
- Signed out: a sign-in card. With either flag off: 404, and the tab is disabled.
- Unit tests cover:
  - the D3 mapping (including the design example, the 30-day boundary, assisted-only, and merge/split);
  - D5 ordering and edge paths;
  - dropping defective edges;
  - lesson numbering and the `?t=` href;
  - padded clock output.
- The DB test covers:
  - another learner's attempts and mastery staying invisible;
  - the limits;
  - the latest independent attempt per concept.

## Checks (Node 22 via nvm)

`npm run typegen` · `npm run typecheck` · `npm run lint` · `npm test` (DB suites with `TEST_DATABASE_URL`, embedded Postgres) · `npm run build`.

## Manual tests

1. Signed out: open `/my-learning/knowledge-map`. Expect the sign-in card; the tab is disabled on `/my-learning`.
2. Signed in, with `knowledge-map` off: expect 404.
3. Signed in, both flags on, the `production` dataset: expect the "No reviewed concepts for this course yet" state.
4. (If D4 is approved) with `NEXT_PUBLIC_SANITY_DATASET=knowledge-map-test` and a local DB:
   - The map matches the reference.
   - Click Loss functions: two attempts, Needs practice.
   - Click the "Lesson N · MM:SS" row: the lesson opens and plays from that second.

## Implementation notes (2026-09-13)

- Worktree `../vertex-knowledge-map`, branch `feat/knowledge-map` off #14 (a807055). **Uncommitted.**
- Differences from the plan:
  - `MAP_LAYOUT` is 190 px nodes, 28 px column gap, 16 px padding, so three columns fit the 662 px map card inside the existing page chrome.
  - Attempt rows are the 5 newest, **displayed oldest first**, as in the reference.
  - Also changed, beyond the expected-file list:
    - `components/ui/icon.tsx`: an `x` glyph;
    - `components/ui/badge.tsx`: `practice`, `developing`, and `neutral` variants;
    - `app/globals.css`: `danger`, `practice(-bg)`, and `developing(-bg)` tokens;
    - `lib/flags.ts`: an `isKnowledgeMapEnabled()` helper;
    - `components/my-learning/knowledge-map/states.ts`: the shared state labels and colours.
  - `ATTEMPT_FEEDBACK_QUERY` lives in `sanity/queries/assessments.ts`, next to the other server-only answer-key queries. It is uncached (`revalidate: 0`).
  - On phones, the state chip sits under the concept name.
- Checks: typecheck, lint, and build pass. `npm test` passes 558/558 with `TEST_DATABASE_URL`, including `lib/knowledge-map.test.ts` and `lib/learner/knowledge-map.db.test.ts`.
- Browser verification (D4), with headless Chrome signed in as a throwaway Clerk test user:
  - Setup:
    - the `knowledge-map-test` dataset, with the RAG course copied from production (images stripped), 6 fixture concepts, 5 edges, 4 assessments, and progress;
    - a local `knowledge_map_dev` DB with 4 attempts and 3 mastery rows;
    - `next dev -p 3011`.
  - Results:
    - States: Embeddings = Recent evidence, Vector indexes = Developing, Chunking = Needs practice (selected by default), and the rest Not assessed. All 5 edges are drawn.
    - The panel shows "Based on 2 attempts; more practice needed.", the chosen-option reasons, and the ASSISTED badge.
    - Clicking a node updates the panel with the scroll position kept, and zoom works.
    - "Lesson 4 · 03:01" → `/lessons/…-chunking-strategies?t=181` → YouTube embed `start=181`.
    - No horizontal page overflow at 390 px. The overview tab links to the map.
  - The flags were forced on by a **temporary** env-guarded line in `lib/flags.ts`. It has been reverted (the file matches the pre-patch copy), so real PostHog evaluation was not exercised in the browser.
  - Cleanup: the Clerk user, the test dataset, and the local DB were deleted, and the dev server on 3011 stopped. Production was only read.
