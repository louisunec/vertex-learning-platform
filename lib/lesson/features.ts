/**
 * Which lesson-page learning features render (development plan §5 PR-7).
 * Pure, so the flag combinations are unit-tested; the lesson page resolves
 * the inputs server-side (`resolve-features.ts`).
 *
 * - check: `lesson-integration` + `learner-evidence`, and at least one item
 *   the lesson's check can issue;
 * - hints on check questions: the check + `help-policy`;
 * - tutor: `lesson-integration` + `learner-evidence` + `help-policy` +
 *   `tutor`, on YouTube only — the one provider whose playhead the page can
 *   read and seek.
 */

export type LessonFeatures = {check: boolean; hints: boolean; tutor: boolean}

export type LessonFeatureInputs = {
  flags: {lessonIntegration: boolean; learnerEvidence: boolean; helpPolicy: boolean; tutor: boolean}
  provider: string | null
  checkItems: number
}

export function decideLessonFeatures({flags, provider, checkItems}: LessonFeatureInputs): LessonFeatures {
  const base = flags.lessonIntegration && flags.learnerEvidence
  const check = base && checkItems > 0
  return {
    check,
    hints: check && flags.helpPolicy,
    tutor: base && flags.helpPolicy && flags.tutor && provider === 'youtube',
  }
}
