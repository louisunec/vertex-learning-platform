# Lesson page: always show the three activity tabs

## Goal

Signed-in learners with `lesson-integration` on always see the activities card with its three tabs,
as in `design/vertex-lessonupdate-tutor.jpg`: Quick check, Explain it back, Submit implementation.
A tab that has nothing on the current lesson says so, instead of disappearing.

The user reported the card missing on `/lessons/building-ai-apps-with-llms-structured-output` and
chose "Always show the tabs" (2026-09-14). This reverses rule 4 of `prompts/lesson-page-integration.md`:
"An unavailable activity is hidden, not shown disabled."

## Inspected: why the card is missing today

- **Quick check:** `lesson.building-ai-apps-with-llms-structured-output` has 0 assessments, and so does
  the rest of Building AI Apps. So `checkItems === 0` makes `features.check` false, the slot is `null`,
  and there's no tab. Only the three Practical Web Security lessons have approved questions (4/7/6),
  and the exact `LESSON_CHECK_CANDIDATES_QUERY` + `toCheckCandidates` return all of them.
- **Explain it back / Submit implementation:** both slots are hard-coded `null` in
  `app/lessons/[slug]/page.tsx`, because PR-8 (#20) and PR-12 (#17) aren't merged. Production also has
  no `explanationTask` or `submissionTask` documents.
- **The whole card vanishes** because `LessonActivities` returns `null` when no slot is available.
- **Not the cause:** the flags. `lesson-integration`, `learner-evidence`, `explain-back` and
  `submission-review` all evaluate true for `user_3IgJHPEOpoyIu6neNNvzFrd3zjY`, and the tutor column
  is visible in the user's screenshot.

Code read: `components/lesson/lesson-activities.tsx`, `lesson-workspace.tsx`, `lesson-check.tsx`
(empty-state styling and copy), `lib/lesson/features.ts`, `resolve-features.ts`, the lesson page, and
`lib/lesson/lesson-ui.test.ts`, which uses `node:test` with pure functions only. `feat/lesson-page-integration`
(`25b3c5b`) and `preview/my-learning` (`a45504b`) have identical copies of the two files that change.

## Decisions

1. **Visibility follows `lesson-integration`.** The page passes `activities` when `features` is
   non-null, which means signed in and `lesson-integration` on. Today it's passed for any signed-in
   user.
   - Signed out, or signed in with the flag off: no card, as now. So an unreleased feature isn't
     advertised as three empty tabs.
   - Later, PR-8 and PR-12 fill their slots inside this gate. They're stacked on PR-7, which owns
     `lesson-integration`.
2. **All three tabs always render,** in the fixed order. Available tabs look the same as today.
   Unavailable tabs:
   - use the same tab style, stay selectable (so their message can be read), and aren't `aria-disabled`;
   - have a panel with one line of `text-body text-neutral-700` copy and no buttons.
3. **Default selection is the first available tab,** or Quick check when none is available. Arrow keys,
   Home and End move across all three tabs.
4. **The empty copy is honest and generic.** A slot can be `null` for more than one reason (no
   content, a flag, or a failed read), so the copy doesn't claim which:
   - Quick check: "There's no quick check for this lesson yet."
   - Explain it back: "There's nothing to explain back for this lesson yet."
   - Submit implementation: "There's no implementation task for this lesson yet."

   The copy lives in one exported map, `ACTIVITY_EMPTY_TEXT`, in a pure module so it's unit-tested.
5. **Selection logic becomes a pure helper.** `activityTabs(slots)` returns all three with
   `available`, and `initialActivity(slots)` returns the default. Both live in `lib/lesson/activities.ts`
   and are tested beside `decideLessonFeatures`.
6. **No change to** analytics (`lesson_tab_selected` still sends the tab label), the slot contract
   types, `ph-no-capture`, or panels staying mounted.

## Expected files (branch `feat/lesson-page-integration`, worktree `../vertex-lesson-page`)

- `lib/lesson/activities.ts` (new): the tab list, `available`, the default tab, and the empty copy.
- `lib/lesson/lesson-ui.test.ts`: tests for the helper.
- `components/lesson/lesson-activities.tsx`: render all three tabs and the empty panels; drop the
  `return null`.
- `app/lessons/[slug]/page.tsx`: `activities` gated on `features` instead of `userId`.
- `prompts/lesson-page-integration.md`: amend rule 4 to point here.

## Delivery

1. Commit on `feat/lesson-page-integration`, as one commit on top of `25b3c5b`. Don't push; I'll ask
   before updating draft PR #19.
2. Merge that commit into the local-only `preview/my-learning` so :3000 hot-reloads it.
   - Keep the uncommitted `components/my-learning/knowledge-map/evidence-panel.tsx` edit there.
   - Never merge the preview back into the feature branch.

## Security

UI only. No new data, routes or flags. The empty states render no learner or content data. Flag
evaluation stays on the server and fails closed; with `lesson-integration` off, nothing changes.

## Acceptance criteria

- On `/lessons/building-ai-apps-with-llms-structured-output`, signed in: the card shows three tabs.
  Quick check is selected, with "There's no quick check for this lesson yet."
- On `/lessons/practical-web-security-sessions-vs-jwt`, signed in: Quick check shows "Start the
  check" as before, and the other two tabs show their empty lines.
- Signed out: no card; the page returns 200.
- A draft answer in Quick check survives switching tabs and coming back.

## Checks

- On the branch: `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`, since the page
  changes.
- After the preview merge: `npm test` with and without `TEST_DATABASE_URL` (:54331), plus a build. I
  report both test counts.
- Rendering: I can't sign in. I'll verify with a temporary harness that forces `features`, and revert
  it before committing, as was done for `25b3c5b`. I'll take screenshots at 1440 and 375 px.

## Manual test (user, signed in on :3000)

1. Open `/lessons/building-ai-apps-with-llms-structured-output` and scroll below Lesson Content /
   Notes. You should see three tabs, each with its "not yet" line.
2. Open `/lessons/practical-web-security-sessions-vs-jwt`. Quick check should show Start the check
   and load a question.
3. Pick an option, switch to Explain it back, then come back. The selection should be kept.

## Implementation notes (2026-09-14, approved by the user)

- Built as planned, with no deviations.
- **Branch checks:** typecheck and lint pass, 479/479 tests, and the build passes.
- **Harness:** a temporary route rendered two cards, one with every slot null and one with a Quick
  check slot. It was removed before the commit.
  - Driven over Chrome DevTools with mobile emulation at 375 and 320 px: no page overflow, and the
    tab row scrolls inside the card.
  - Clicking a tab and Home/End/arrow keys switch panels. The Quick check panel's content is still
    mounted after a round trip.
- **Headless Chrome caveat:** plain `--window-size` below about 500 px doesn't narrow the layout. Use
  `Emulation.setDeviceMetricsOverride` for phone widths.
