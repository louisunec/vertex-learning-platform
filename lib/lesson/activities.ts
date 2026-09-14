/**
 * The lesson page's activity tabs (`components/lesson/lesson-activities.tsx`).
 * Pure, so which tabs are available and which one opens first are unit-tested.
 *
 * All three tabs always render, in a fixed order. A tab whose slot is `null`
 * has nothing on this lesson: its panel shows `ACTIVITY_EMPTY_TEXT`. A slot is
 * null for more than one reason (no content, a flag, a failed read), so the
 * copy doesn't claim which.
 */

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

/** The tab selected before the learner picks one: the first available, or Quick check when none is. */
export function initialActivity(tabs: ActivityTab[]): ActivityKey {
  return (tabs.find((tab) => tab.available) ?? tabs[0]).key
}
