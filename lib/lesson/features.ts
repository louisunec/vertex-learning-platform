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
 *
 * When the tutor is off, `tutorUnavailable` says why, so the page can show an
 * honest unavailable state: `provider` when every flag is on but the video is
 * one the page can't follow, `rollout` when a flag keeps it off.
 */

export type TutorUnavailableReason = 'rollout' | 'provider'

export type LessonFeatures = {
  check: boolean
  hints: boolean
  tutor: boolean
  tutorUnavailable: TutorUnavailableReason | null
}

export type LessonFeatureInputs = {
  flags: {lessonIntegration: boolean; learnerEvidence: boolean; helpPolicy: boolean; tutor: boolean}
  provider: string | null
  checkItems: number
}

export function decideLessonFeatures({flags, provider, checkItems}: LessonFeatureInputs): LessonFeatures {
  const base = flags.lessonIntegration && flags.learnerEvidence
  const check = base && checkItems > 0
  const enabled = base && flags.helpPolicy && flags.tutor
  const tutor = enabled && provider === 'youtube'
  return {
    check,
    hints: check && flags.helpPolicy,
    tutor,
    tutorUnavailable: tutor ? null : enabled ? 'provider' : 'rollout',
  }
}
