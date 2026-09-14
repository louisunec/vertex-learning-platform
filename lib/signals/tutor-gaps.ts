import type postgres from 'postgres'

import {asSignalsWorker} from '../db/worker-scope.ts'
import {rate, type SignalCandidate} from './candidate.ts'
import type {SignalThresholds} from './config.ts'
import type {SignalWindow} from './windows.ts'

/**
 * Tutor questions answered with insufficient evidence, from the tutor's own
 * records (`learner.tutor_request`, PR-6), one aggregate per lesson per
 * window.
 *
 * `insufficient_evidence` is recorded only after retrieval actually ran
 * (window, then lesson, then course scope) and found nothing usable. A
 * provider error, timeout, or Sanity outage throws before the record is
 * written (a retryable 503), so infrastructure failures never appear here
 * and cannot become content-gap signals. No question text is stored, so
 * none can be shown. "Not retrieved" is never proof that the course lacks
 * the topic: the reason text says only what was searched.
 *
 * When the tutor flag is off this source is simply empty.
 */

export type TutorAggregate = {
  lessonId: string
  requests: number
  askers: number
  insufficient: number
  insufficientLearners: number
  insufficientCourseScope: number
  clarificationNeeded: number
}

export type PlayheadBucket = {lessonId: string; bucketSeconds: number; learners: number}

export const PLAYHEAD_BUCKET_SECONDS = 60

export async function readTutorAggregates(
  db: postgres.Sql,
  window: SignalWindow,
): Promise<{aggregates: TutorAggregate[]; buckets: PlayheadBucket[]}> {
  return asSignalsWorker(db, async (tx) => {
    const aggregates = await tx<TutorAggregate[]>`
      select
        t.lesson_id as "lessonId",
        count(*)::int as "requests",
        count(distinct t.learner_id)::int as "askers",
        count(*) filter (where t.status = 'insufficient_evidence')::int as "insufficient",
        count(distinct t.learner_id) filter (where t.status = 'insufficient_evidence')::int as "insufficientLearners",
        count(*) filter (where t.status = 'insufficient_evidence' and t.scope = 'course')::int as "insufficientCourseScope",
        count(*) filter (where t.status = 'clarification_needed')::int as "clarificationNeeded"
      from learner.tutor_request t
      where t.created_at >= ${window.start} and t.created_at < ${window.end}
        and not exists (select 1 from learner.synthetic_learner s where s.learner_id = t.learner_id)
      group by t.lesson_id
      order by t.lesson_id
    `
    const buckets = await tx<PlayheadBucket[]>`
      select
        t.lesson_id as "lessonId",
        (floor(t.current_seconds / ${PLAYHEAD_BUCKET_SECONDS}::float8) * ${PLAYHEAD_BUCKET_SECONDS})::int as "bucketSeconds",
        count(distinct t.learner_id)::int as "learners"
      from learner.tutor_request t
      where t.created_at >= ${window.start} and t.created_at < ${window.end}
        and t.status = 'insufficient_evidence' and t.current_seconds is not null
        and not exists (select 1 from learner.synthetic_learner s where s.learner_id = t.learner_id)
      group by 1, 2
    `
    return {aggregates, buckets}
  })
}

/** The playhead bucket most learners asked from, if at least two share it (ties: earliest). */
function modalBucket(buckets: PlayheadBucket[]): PlayheadBucket | null {
  const best = buckets.toSorted((a, b) => b.learners - a.learners || a.bucketSeconds - b.bucketSeconds)[0]
  return best && best.learners >= 2 ? best : null
}

export function evaluateTutorGap(
  row: TutorAggregate,
  buckets: PlayheadBucket[],
  thresholds: SignalThresholds['tutor'],
): SignalCandidate {
  const thresholdMet = row.insufficientLearners >= thresholds.minLearners
  const bucket = modalBucket(buckets.filter((entry) => entry.lessonId === row.lessonId))
  const rule = `Raised when at least ${thresholds.minLearners} distinct learners get an insufficient-evidence tutor answer on one lesson in the window.`
  const reason = thresholdMet
    ? `${row.insufficientLearners} learners asked tutor questions for which it could not find enough supporting material in the course sources searched. This does not show that the course never covers the topic; the questions themselves are not stored.`
    : `${row.insufficientLearners} learner(s) got an insufficient-evidence answer; the rule needs ${thresholds.minLearners}.`
  return {
    type: 'tutor_insufficient_evidence',
    subjectKey: row.lessonId,
    thresholdMet,
    reason,
    lessonId: row.lessonId,
    assessment: null,
    timestamp: bucket ? {startSeconds: bucket.bucketSeconds, endSeconds: bucket.bucketSeconds + PLAYHEAD_BUCKET_SECONDS} : null,
    measurement: {
      numerator: row.insufficient,
      numeratorLabel: 'Tutor answers with insufficient supporting evidence',
      denominator: row.requests,
      denominatorLabel: 'Tutor questions answered on this lesson (provider and retrieval failures are never recorded)',
      rate: rate(row.insufficient, row.requests),
      distinctLearners: row.insufficientLearners,
    },
    supporting: [
      {key: 'insufficient_course_scope', label: 'Insufficient after searching the whole course', value: row.insufficientCourseScope},
      {key: 'clarification_needed', label: 'Questions too ambiguous to answer (not counted)', value: row.clarificationNeeded},
      {key: 'askers', label: 'Distinct learners who asked the tutor on this lesson', value: row.askers},
      ...(bucket ? [{key: 'playhead_bucket_learners', label: 'Learners asking from the most common minute', value: bucket.learners}] : []),
    ],
    searchTerms: null,
    rule,
  }
}
