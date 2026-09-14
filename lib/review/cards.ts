import type {LearnerTx} from '../db/learner-scope.ts'
import {ALGORITHM_VERSION, cardStateJson, newCardState, PARAMS_VERSION, rateCard, type CardState} from './fsrs.ts'
import {decideRating, RATING_POLICY_VERSION, type RatingFacts} from './rating.ts'

/**
 * Scheduled-review cards (development plan §5 PR-9,
 * prompts/pr-9-scheduled-review.md): one per learner, stable concept id, and
 * item type. Every function takes the caller's `asLearner` transaction, so
 * row level security confines it to that learner's rows.
 */

export const TASK_TYPES = ['recall', 'apply', 'transfer'] as const
export type TaskType = (typeof TASK_TYPES)[number]

/** What one graded answer did to the learner's schedule; the attempt response carries it. */
export type ScheduleOutcome = {status: 'scheduled'; dueAt: Date} | {status: 'not_scheduled'; reason: 'assisted_correct'}

export type CardRow = CardState & {id: string; conceptId: string; taskType: TaskType}

/**
 * Records one graded answer on the learner's card for (`conceptId`,
 * `taskType`), inside the attempt's own transaction. The card is created
 * New on first sight and then locked, so concurrent answers on different
 * families of one card apply in order. A rating updates the card; an
 * unrated assisted correct answer leaves it byte-for-byte unchanged. Either
 * way one immutable `review_log` row names the attempt, so a replay can't
 * log it twice.
 */
export async function recordReviewObservation(
  tx: LearnerTx,
  learnerId: string,
  {attemptId, conceptId, taskType, now, ...facts}: RatingFacts & {attemptId: string; conceptId: string; taskType: TaskType; now: Date},
): Promise<ScheduleOutcome> {
  const fresh = newCardState(now)
  await tx`
    insert into learner.review_card (
      learner_id, concept_id, task_type,
      due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review,
      algorithm_version, params_version, rating_policy_version, created_at, updated_at
    ) values (
      ${learnerId}, ${conceptId}, ${taskType},
      ${fresh.due}, ${fresh.stability}, ${fresh.difficulty}, ${fresh.elapsedDays}, ${fresh.scheduledDays},
      ${fresh.learningSteps}, ${fresh.reps}, ${fresh.lapses}, ${fresh.state}, ${fresh.lastReview},
      ${ALGORITHM_VERSION}, ${PARAMS_VERSION}, ${RATING_POLICY_VERSION}, ${now}, ${now}
    )
    on conflict (learner_id, concept_id, task_type) do nothing
  `
  const [card] = await tx<CardRow[]>`
    select
      id, concept_id as "conceptId", task_type as "taskType",
      due, stability, difficulty, elapsed_days as "elapsedDays", scheduled_days as "scheduledDays",
      learning_steps as "learningSteps", reps, lapses, state, last_review as "lastReview"
    from learner.review_card
    where learner_id = ${learnerId} and concept_id = ${conceptId} and task_type = ${taskType}
    for update
  `

  const decision = decideRating(facts)
  const next = decision.outcome === 'rated' ? rateCard(card, decision.rating, now) : card
  if (decision.outcome === 'rated') {
    await tx`
      update learner.review_card set
        due = ${next.due}, stability = ${next.stability}, difficulty = ${next.difficulty},
        elapsed_days = ${next.elapsedDays}, scheduled_days = ${next.scheduledDays}, learning_steps = ${next.learningSteps},
        reps = ${next.reps}, lapses = ${next.lapses}, state = ${next.state}, last_review = ${next.lastReview},
        algorithm_version = ${ALGORITHM_VERSION}, params_version = ${PARAMS_VERSION},
        rating_policy_version = ${RATING_POLICY_VERSION}, updated_at = ${now}
      where id = ${card.id}
    `
  }
  await tx`
    insert into learner.review_log (
      learner_id, card_id, attempt_id, outcome, rating, previous_state, new_state, reviewed_at,
      algorithm_version, params_version, rating_policy_version
    ) values (
      ${learnerId}, ${card.id}, ${attemptId}, ${decision.outcome}, ${decision.outcome === 'rated' ? decision.rating : null},
      ${tx.json(cardStateJson(card))}, ${tx.json(cardStateJson(next))}, ${now},
      ${ALGORITHM_VERSION}, ${PARAMS_VERSION}, ${RATING_POLICY_VERSION}
    )
  `
  return decision.outcome === 'rated' ? {status: 'scheduled', dueAt: next.due} : {status: 'not_scheduled', reason: 'assisted_correct'}
}

/** The schedule an attempt produced, for an idempotent replay; null when it reached no card. */
export async function readScheduleForAttempt(tx: LearnerTx, attemptId: string): Promise<ScheduleOutcome | null> {
  const [row] = await tx<{outcome: string; due: string}[]>`
    select outcome, new_state->>'due' as due from learner.review_log where attempt_id = ${attemptId}
  `
  if (!row) return null
  return row.outcome === 'rated' ? {status: 'scheduled', dueAt: new Date(row.due)} : {status: 'not_scheduled', reason: 'assisted_correct'}
}

/** The learner's cards due at `now`, oldest due first. */
export async function readDueCards(tx: LearnerTx, learnerId: string, now: Date, limit: number): Promise<CardRow[]> {
  const rows = await tx<CardRow[]>`
    select
      id, concept_id as "conceptId", task_type as "taskType",
      due, stability, difficulty, elapsed_days as "elapsedDays", scheduled_days as "scheduledDays",
      learning_steps as "learningSteps", reps, lapses, state, last_review as "lastReview"
    from learner.review_card
    where learner_id = ${learnerId} and due <= ${now}
    order by due, id
    limit ${limit}
  `
  return [...rows]
}

/** How many of the learner's cards are due at `now`, and when the next one after `now` falls due. */
export async function readDueSummary(tx: LearnerTx, learnerId: string, now: Date): Promise<{due: number; nextDueAt: Date | null}> {
  const [row] = await tx<{due: number; nextDueAt: Date | null}[]>`
    select
      count(*) filter (where due <= ${now})::int as due,
      min(due) filter (where due > ${now}) as "nextDueAt"
    from learner.review_card
    where learner_id = ${learnerId}
  `
  return row
}
