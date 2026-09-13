# PR-7: Integrate tutoring and practice into the lesson page

Status: **approved 2026-09-13** (Yes). The user chose: base = My Learning #14; variant = same
reviewed concept.

## Goal

Deliver one complete loop on the lesson page (development plan §5 PR-7): watch → ask the tutor at the
current second → check understanding with reviewed questions (optional confidence, reviewed hints) →
after an assisted or wrong answer, an unseen reviewed variant without hints for independent evidence.
Everything ships behind a new, default-off flag; with it off the page is exactly today's page.

## Guidance read

- `AGENTS.md`, `CLAUDE.md`, `docs/Vertex_AI_Native_Development_Plan.md` §3 (authorization, evidence
  envelope), §5 PR-4/5/6/7, §6 release gates.
- Memory: stack status (#9 → #10 → #11 → #12 draft → #14), `asLearner` RLS rule, flags fail closed,
  sign-in required for tutor/practice/attempts, live content counts.
- To read before coding: `node_modules/next/dist/docs/` guides for route handlers and client
  components (Next 16.3.3).

## Code inspected (tip `feat/my-learning-overview` @ a807055)

- `app/lessons/[slug]/page.tsx`: RSC page; `VideoEmbed` keyed by `embedSrc`; `after()` analytics.
- `components/lesson/video-embed.tsx`: YouTube IFrame API attached in an effect; the player object is
  local to the effect closure. It computes the 90% milestone (`COMPLETION_MILESTONE`) and saves progress.
- `lib/video/youtube-iframe-api.ts`: `YouTubePlayer` types only `getCurrentTime`/`getDuration`; no seek.
- `app/api/task-instances`, `app/api/attempts`, `app/api/help`, `app/api/tutor` and their services in
  `lib/learner/*`, `lib/tutor/service.ts`; contracts in `lib/learner/contracts.ts`.
  - Task issue needs an explicit `assessmentId`. Nothing chooses a lesson's question set or an
    unseen variant, and `LESSON_PRACTICE_ITEMS_QUERY` has no consumer.
  - Help: `hint` (first help = 1, repeat = same), `escalate` (+1), `solution` (3, carries
    `correctOptionId`). Tutor accepts `currentSeconds`, `sessionId`, `taskInstanceId`, `helpRequest`.
  - Evidence (`lib/learner/evidence.ts`): first attempt on a family with no help = independent; any
    help on the family = assisted; repeats not counted. Mastery updates the resolved primary concept.
- `lib/flags.ts` (PostHog, fail closed), `lib/learner/http.ts` (`code` + `retryable` errors),
  `lib/db/client.ts` (throws `DatabaseUnavailableError` when `DATABASE_URL` is unset),
  `components/ui/*` (no dialog/drawer primitive exists), `instrumentation-client.ts` (autocapture and
  exception capture on).
- Studio `assessment` schema: `objective` is free text written per item by the model, so it is not a
  reliable grouping key; `primaryConcept` is the reviewed link that mastery uses.
- Live `production` dataset (read 2026-09-13): 120 lessons, all YouTube; **0 assessments, 0 concepts**.

## Decisions and assumptions

1. **Base.** New worktree `../vertex-pr-7` on `feat/pr-7-lesson-integration` off `feat/my-learning-overview`
   (a807055, PR #14); PR base `feat/my-learning-overview`. #14 already edits the lesson page and
   `video-embed.tsx`, the files PR-7 changes; basing on PR-6 would guarantee conflicts. (#14 is not a
   plan prerequisite: this is your call.)
2. **Flag.** New `lesson-integration` (`FLAGS.lessonIntegration`), evaluated in the lesson RSC for
   signed-in learners only, in parallel with the prerequisites:
   - check shown: `lesson-integration` + `learner-evidence`, and the lesson has ≥ 1 servable item;
   - hint buttons: the above + `help-policy`;
   - tutor shown: `lesson-integration` + `learner-evidence` + `help-policy` + `tutor`, YouTube only
     (the only provider whose position we can read and seek). `tutor` stays off (pilot gate unmet).
   Signed-out learners and any flag off: nothing new renders and no DB access happens at render.
3. **Server-side selection, new route** `POST /api/lesson-check` (PR-4 routes unchanged):
   - body (strict) `{lessonId, kind: 'check' | 'follow_up', afterTaskInstanceId?}` (required iff
     `follow_up`); the client never chooses an assessment.
   - Candidates: new learner-safe query `LESSON_CHECK_CANDIDATES_QUERY` with the same servable rules as
     `LESSON_PRACTICE_ITEMS_QUERY`, projecting only `_id, familyId, version, primaryConcept._ref`,
     earliest `sourceChunkRefs[].startSeconds`. No question text, answer key, or hints.
   - Group families by resolved primary concept (existing `resolveConcept`, so merges redirect);
     an item without a resolvable concept is its own group. Order groups by earliest source second.
   - `check`: the next group with **no attempt** by this learner; issue its first family. This keeps
     same-concept siblings in reserve for follow-ups. Returns grounded `{remaining, total}` group counts.
   - `follow_up`: the answered, owned, same-lesson instance's group; first family in it with no attempt.
     **Variant = an unattempted approved family on the same reviewed primary concept, same lesson.**
     No concept or no sibling → `{status: 'none', reason: 'no_variant'}` (an unavailable state, never
     evidence).
   - An owned, unexpired, unanswered instance for the chosen family is resumed instead of issuing a
     duplicate (still `matchesDelivery`-checked); otherwise `issueTask` is reused.
   - Other outcomes: `no_items`, `all_checked`; `not_found` for another learner's or another lesson's
     instance; `invalid_request` when the follow-up source is unanswered.
   - Learner reads go through `asLearner`; Sanity reads happen outside transactions.
4. **Player bridge.** A client `LessonPlayerProvider` context holds the YouTube player registered by
   `VideoEmbed` (`onReady`), exposing `getPosition()`, `seekTo(seconds)` and a completion subscription
   fired from the existing 90% milestone / `ENDED`. `YouTubePlayer` gains `seekTo` and `playVideo`.
   `key={embedSrc}` is unchanged, so opening panels or drawers never remounts the iframe. Before the
   player is ready, position = the page's start second (where the embed is cued).
5. **Help mapping** (check and tutor): "Get a hint" = `hint`; "Another hint" = `escalate`, offered only
   at level 1; "Show the explanation" = `solution`, offered at levels 1–2 and after a wrong answer.
   At level 2 "Another hint" is hidden because the next step *is* the solution. Tutor mode toggle:
   "Guide me" (`study`) / "Just explain" (`reference`). Follow-up questions show no help buttons; if
   the tutor is used anyway, the server records it as assisted and the UI says so.
6. **Ids.** `crypto.randomUUID()` for request/idempotency keys (fits `IDEMPOTENCY_KEY`) and one tutor
   `sessionId` per page load (fits `SESSION_ID`). Session ids are client-generated, as PR-6's contract
   allows: help level on free questions is not an access boundary (reference mode is always level 3).
   Task identity is server-issued. While a check question is open the tutor sends its `taskInstanceId`.
   Network/503 retries reuse the same key (replays return the stored result, no double evidence).
7. **Citations.** Contiguous same-lesson citations of one statement collapse into one time-range
   button (the rule documented on `tutorStatementSchema`); ids stay separate. Same lesson →
   `seekTo(startSeconds)` + scroll the player into view (drawer closes on mobile). Other lesson or
   player not ready → navigate to the server-built `href` (`?t=` keeps the second).
8. **Invitation.** On the first completion signal, if the check is available and not already open, show
   an inline, non-modal, dismissible invitation once per `lessonId` + lesson `_rev` (localStorage; `_rev`
   added to `LESSON_BY_SLUG_QUERY`). Mastery is never inferred from playback.
9. **Check flow.** Up to 3 questions per sitting (fewer when inventory is sparse, with no invented
   categories). Optional 1–5 confidence is collected before submit. The result shows correct/not
   correct and, from the server's evidence kind, whether it counted as independent or practice with
   help. Offer the follow-up whenever the result is not independent-and-correct.
10. **Layout.** No reference images exist, so this reuses current tokens/components. The check is an
    inline card under the video. The tutor is an inline collapsible card under the video on `lg+` and a
    native `<dialog>` bottom drawer below `lg` (focus trap, Escape, labelled, focus returns to trigger).
11. **Analytics** (posthog-js, ids and enums only, never question/answer/option text):
    - `tutor_asked` {lesson_slug, course_slug, mode, help_request, has_task, status|error_code, scope,
      help_level};
    - `hint_escalated` {source: check|tutor, request, level};
    - `check_answered` {lesson_slug, course_slug, check_kind, question_number, confidence_given}.
    No grades or evidence kinds in client events; the server outbox owns those. Tutor and check
    containers get `ph-no-capture` to keep learning text out of autocapture and replay.

## Expected files

- `lib/flags.ts`: add `lessonIntegration`.
- `sanity/queries/assessments.ts`: `LESSON_CHECK_CANDIDATES_QUERY`.
- `sanity/queries/lessons.ts`: `_rev`; `sanity.types.ts` via typegen.
- `lib/learner/content-source.ts`, `content.ts`, `test-content.ts`: `loadLessonCheckCandidates`.
- `lib/learner/contracts.ts`: lesson-check request/response schemas (strict).
- `lib/learner/lesson-check.ts`: pure selection + service.
- `app/api/lesson-check/route.ts`.
- `lib/lesson/citations.ts`, `lib/lesson/help-actions.ts`: framework-free UI logic.
- `lib/video/youtube-iframe-api.ts`: `seekTo`, `playVideo`, `onReady`.
- `components/lesson/lesson-player.tsx`: provider context.
- `components/lesson/video-embed.tsx`: register player, completion callback.
- `components/lesson/tutor-panel.tsx`, `components/lesson/lesson-check.tsx`, `components/lesson/drawer.tsx`.
- `app/lessons/[slug]/page.tsx`: flags, candidate count, render.
- Tests listed below; this prompt, copied into the worktree.

## Security

- Identity only from `auth()`; 401 signed-out; any required flag off → 404 before content/DB access.
- Strict bodies: no user id, level, correctness, or assessment id from the client in `/api/lesson-check`.
- Responses: learner-safe item only; the RSC payload carries booleans, ids, and `_rev`, never items.
- Another learner's instance is indistinguishable from none (RLS + owner filter).
- No new env vars and no new credentials.

## Acceptance criteria

- Flag off, signed-out, DB unset, or 0 items: lesson page renders as today, with no DB access at render.
- Tutor: asks at the real playhead; renders supported/partial/insufficient/clarification states; the
  help buttons follow decision 5; citation buttons seek in place or navigate with `?t=`; loading, 429,
  503-retry (same key), 409 states; drawer keyboard-operable on mobile; playback not interrupted.
- Check: server-selected questions; confidence optional and pre-feedback; hints via `/api/help`;
  duplicate clicks can't double-submit; expired → new question; `no_items` / `all_checked` / `no_variant`
  shown honestly.
- An independent learner and an assisted-then-follow-up learner produce different `attempt_log` /
  `concept_mastery` histories (DB test).
- No answer key, hints beyond the decided rung, or learning text in route/RSC responses or analytics.

## Checks

- `npm test` with `TEST_DATABASE_URL` (embedded Postgres on 54329):
  - `lib/learner/lesson-check.test.ts`: grouping, merge redirect, ordering, attempted groups skipped,
    counts, `no_items`/`all_checked`/`no_variant`, follow-up sibling rules, resume.
  - `lib/learner/lesson-check.db.test.ts`: ownership, lesson mismatch, unanswered source, RLS,
    evidence-history contrast.
  - Route test (the `help-route.db.test.ts` pattern): 401, flags off 404, strict body, and a response
    scan for `correctOptionId`/`answerKey`/`hints`.
  - `lib/lesson/citations.test.ts`, `lib/lesson/help-actions.test.ts`.
- `npm run typecheck`, `npm run lint`, `npm run build`.

## Manual tests

1. Signed-out, open `/lessons/<any slug>`: unchanged page, no new requests.
2. Signed-in with `lesson-integration` off: unchanged.
3. Signed-in, flags on for your user, local `DATABASE_URL` (migrated): the tutor appears; play to ~1:00,
   ask a lesson question and check that the answer cites near 1:00; click a citation (seeks, no
   reload); "Another hint" / "Show the explanation"; resize to mobile (drawer, Escape, focus return).
   This makes live OpenAI calls. I run it only if you allow.
4. Same, on a lesson with 0 items: no check card, no invitation.
5. Full check loop in the browser: **blocked**. There are no reviewed assessments in any dataset, and
   production must not be seeded. It is covered by the DB tests only until reviewed content exists.

## Rollback

Turn `lesson-integration` off: the lesson hooks disappear and the page layout is today's. The learner
tables, attempts, and help events are retained. No migration and no content change.

## Implementation notes (2026-09-13)

- Files added beyond the expected list:
  - `lib/lesson/features.ts` (pure flag combination) and `lib/lesson/resolve-features.ts` (server-only
    flag + item-count read);
  - `lib/lesson/api.ts` (fetch helper, request keys);
  - `components/lesson/lesson-assist.tsx` (shares the open check question with the tutor);
  - `components/lesson/use-media-query.ts`.
  The client helper tests are in one file, `lib/lesson/lesson-ui.test.ts`.
- The candidates query also returns the learner-safe item, parsed through `toLearnerAssessments`, so a
  candidate is always issuable. It is not a second answer-free projection.
- A resumed instance returns 200 and a new one 201.
- The tutor playhead is clamped to the lesson's stored duration: the route rejects anything past the
  stored bound. The route's bound is the video document's duration, falling back to the lesson's.
- The tutor gets the check question's `taskInstanceId` only while that question is unanswered.
- Rendering a fresh worktree: `npm run typegen` needs the gitignored `studio/.env`. Without it,
  typegen fails and `tsc` then reports loose lesson types.
- Verified:
  - `npm test` 565/565, with `TEST_DATABASE_URL`;
  - typecheck, lint, and build pass;
  - `next start`, signed out: the lesson page has no new UI and `/api/lesson-check` returns 401.
  Manual tests 2–4 were not run (flags and sign-in). Test 5 is blocked.
