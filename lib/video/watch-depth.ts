/**
 * Watch-depth milestones for playback analytics. Framework-free so the rule is
 * unit-tested independently of any provider player.
 */

/** Percent-of-duration milestones, each reported at most once per page view. */
export const WATCH_DEPTH_MILESTONES = [25, 50, 75, 90] as const

export type WatchDepthMilestone = (typeof WATCH_DEPTH_MILESTONES)[number]

/** Milestone that also counts as an analytics-only lesson completion. */
export const COMPLETION_MILESTONE: WatchDepthMilestone = 90

/**
 * Milestones newly reached at `positionSeconds`, in ascending order.
 * Position-based: seeking forward past a milestone counts as reaching it.
 * Milestones at or below the start position never count — a learner who
 * resumed at 60 % did not watch 25 % or 50 %.
 */
export function reachedMilestones({
  positionSeconds,
  durationSeconds,
  startSeconds,
  reported,
}: {
  positionSeconds: number
  durationSeconds: number
  startSeconds: number | null
  reported: ReadonlySet<WatchDepthMilestone>
}): WatchDepthMilestone[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !Number.isFinite(positionSeconds)) {
    return []
  }
  const positionPercent = (positionSeconds / durationSeconds) * 100
  const startPercent = ((startSeconds ?? 0) / durationSeconds) * 100
  return WATCH_DEPTH_MILESTONES.filter(
    (milestone) => milestone > startPercent && positionPercent >= milestone && !reported.has(milestone),
  )
}
