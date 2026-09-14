# Lesson page: one tab row for content and activities

## Goal

Quick check, Explain it back and Submit implementation sit in the same tab row as Lesson Content and
Notes. There's no separate activities card. The user asked for this on 2026-09-14, after
`prompts/lesson-activities-always-visible.md` (`c166ac7`).

It departs from `design/vertex-lessonupdate-tutor.jpg`, which shows two cards. The user's instruction
wins.

## Inspected

- `components/lesson/lesson-tabs.tsx`
  - Two tabs, content and notes, with both panels mounted (`hidden`).
  - `lesson_tab_selected` fires with the tab label.
  - No keyboard navigation and no horizontal overflow handling.
  - The selected tab has `text-neutral-900` and a mint underline.
- `components/lesson/lesson-activities.tsx`
  - The activities card: three tabs, "not yet" lines, and roving `tabIndex`.
  - Home, End and arrow keys move between tabs.
  - Panels carry `ph-no-capture @container`, and the tab row scrolls (`overflow-x-auto`).
- `components/lesson/lesson-workspace.tsx`
  - Renders `content` and then the `activities` card, both inside `LessonPlayerProvider`.
  - So the check keeps access to the player and to the tutor's shared open task wherever it renders.
- `app/lessons/[slug]/page.tsx`: builds the three activity slots when `features` is non-null.
- `lib/lesson/activities.ts`: the tab list, the empty copy, and `initialActivity`.
- `lesson-check.tsx`: shows an invite when `player.onCompleted` fires, once per lesson revision.

## Decisions

1. **One tab row:** Lesson Content, Notes, Quick check, Explain it back, Submit implementation.
   - The three activity tabs appear only when `activities` is non-null (signed in with
     `lesson-integration` on), and then all three always show.
   - Signed out, or with the flag off: exactly today's two tabs.
2. **Lesson Content stays selected by default.**
3. **Every panel stays mounted,** so an open question, a draft explanation or pasted code survives
   switching tabs, and the tutor still sees the open check question.
   - Activity panels keep `ph-no-capture @container` and the "not yet" line.
   - Content and Notes panels keep `pt-8`.
4. **One style:** today's Lesson Content / Notes style for all five tabs.
   - The row gets `overflow-x-auto` and `whitespace-nowrap`, so it scrolls on phones instead of
     wrapping.
   - Roving `tabIndex` and Home/End/arrow keys cover all five tabs.
5. **Analytics:** no change. The same `lesson_tab_selected` event is sent with the tab label.
6. **The end-of-video invite:** the user's choice (see the question). Recommended: a small mint dot on
   the Quick check tab after the video completes, while that tab isn't selected; opening the tab
   clears it.
   - The invite text itself stays inside the Quick check panel, unchanged.
   - The dot shows only when Quick check has content.
7. **Code structure**
   - `LessonTabs` gains an optional `activities` prop. `lesson-activities.tsx` is deleted.
   - The `LessonActivitySlots` type moves to `lib/lesson/activities.ts`, so the PR-8/PR-12 slot
     contract is unchanged.
   - `LessonWorkspace` loses its `activities` prop.
   - `initialActivity` goes, since Lesson Content is the default; its tests go with it.

## Expected files (`feat/lesson-page-integration`, `../vertex-lesson-page`)

- `components/lesson/lesson-tabs.tsx`: five tabs, keyboard navigation, overflow, the activity panels,
  and the dot.
- `components/lesson/lesson-activities.tsx`: deleted.
- `components/lesson/lesson-workspace.tsx`: `activities` removed.
- `app/lessons/[slug]/page.tsx`: slots passed to `LessonTabs`.
- `lib/lesson/activities.ts` and `lesson-ui.test.ts`: the slot type moves in, `initialActivity` goes.
- `prompts/lesson-page-integration.md`: point to this prompt.

## Delivery

One local commit on `feat/lesson-page-integration`, not pushed. It's then merged into the local-only
`preview/my-learning` (:3000 hot-reloads), keeping the uncommitted `evidence-panel.tsx` edit.

## Security

UI only: no data, routes or flags change. The server gating is identical to `c166ac7`.

## Acceptance criteria

- Signed in on any lesson, one row reads Lesson Content · Notes · Quick check · Explain it back ·
  Submit implementation, with no second card.
- Lesson Content is selected on load, and each activity tab shows its content or its "not yet" line.
- On a Practical Web Security lesson, Quick check → Start the check works. An answer in progress
  survives switching to Notes and back.
- At 375 and 320 px the row scrolls inside the column, and the page doesn't scroll sideways.
- Signed out: only Lesson Content · Notes, and the page returns 200.

## Checks

- `npm run typecheck`, `npm run lint`, `npm test` and `npm run build` on the branch.
- After the preview merge: `npm test` with and without `TEST_DATABASE_URL` (:54331), and a build.
- A temporary harness driven over Chrome DevTools with mobile emulation: clicks, keys, mounted panels,
  and the dot on a simulated completion. The harness is removed before the commit.
- Signed in on :3000: by you, since I can't sign in.

## Manual test (you, signed in on :3000)

1. Open `/lessons/practical-web-security-sessions-vs-jwt`. There should be one row of five tabs.
2. Open Quick check, choose an option, go to Notes and back. The option should still be selected.
3. Open `/lessons/building-ai-apps-with-llms-structured-output`. Each activity tab should show its
   "not yet" line.

## Implementation notes (2026-09-14, approved; invite choice: dot on the tab)

- **Deviation (styling only):** now that the row scrolls sideways (`overflow-x-auto`), the old
  `border-b` plus `-mb-px` underline overflowed by 1 px. That clipped the selected underline to 1 px
  and let the row scroll vertically.
  - The divider is now an inset shadow in `--color-neutral-200`, so the 2 px underline sits on it.
  - Focus rings are `ring-inset`, so they aren't clipped either.
  - Measured vertical overflow after the change: 0.
- **Branch checks:** typecheck and lint pass, 478/478 tests (the three `initialActivity` asserts went
  with it), and the build passes.
- **Harness** (removed before the commit), driven over CDP:
  - five tabs signed in and two signed out; Lesson Content selected on load;
  - a typed draft in the Quick check slot survives Notes and back;
  - End, and ArrowRight wrapping, both work;
  - a simulated completion on Lesson Content shows the dot (the screen reader hears "Quick check,
    questions ready"); opening Quick check clears it, and a completion while it's open adds none;
  - at 375 and 320 px the page doesn't scroll sideways, and the row scrolls inside the column.
