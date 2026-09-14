import type {ReactNode} from 'react'

/**
 * The lesson page's activity tabs, which follow Lesson Content and Notes in
 * one row (`components/lesson/lesson-tabs.tsx`). Pure, so which tabs are
 * available is unit-tested.
 *
 * All three tabs always render, in a fixed order. A tab whose slot is `null`
 * has nothing on this lesson: its panel shows `ACTIVITY_EMPTY_TEXT`. A slot is
 * null for more than one reason (no content, a flag, a failed read), so the
 * copy doesn't claim which.
 */

/**
 * Each activity is rendered by the PR that owns it and passed in already
 * resolved for this learner and lesson; `null` means it isn't available here.
 *
 * - `quickCheck`: PR-7 `LessonCheck`, when `features.check`;
 * - `explainBack`: PR-8 `ExplainBack` (embedded), when `resolveExplainTask` returns a task;
 * - `submitImplementation`: PR-12 `SubmissionReview` (embedded), when `resolveSubmissionTask` returns a task.
 */
export type LessonActivitySlots = {
  quickCheck: ReactNode | null
  explainBack: ReactNode | null
  submitImplementation: ReactNode | null
}

export const ACTIVITIES = [
  {key: 'quickCheck', label: 'Quick check'},
  {key: 'explainBack', label: 'Explain it back'},
  {key: 'submitImplementation', label: 'Submit implementation'},
] as const

export type ActivityKey = (typeof ACTIVITIES)[number]['key']

export const ACTIVITY_EMPTY_TEXT: Record<ActivityKey, string> = {
  quickCheck: "There's no quick check for this lesson yet.",
  explainBack: "There's nothing to explain back for this lesson yet.",
  submitImplementation: "There's no implementation task for this lesson yet.",
}

export type ActivityTab = (typeof ACTIVITIES)[number] & {available: boolean}

/** Every tab in order, marked available when its slot has content. */
export function activityTabs(slots: Record<ActivityKey, unknown>): ActivityTab[] {
  return ACTIVITIES.map((activity) => ({...activity, available: slots[activity.key] != null}))
}
