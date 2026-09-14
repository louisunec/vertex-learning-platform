import {createEmptyCard, fsrs, generatorParameters, type Card, type Grade} from 'ts-fsrs'

import {AGAIN, GOOD} from './rating.ts'

/**
 * The application's only use of `ts-fsrs` (development plan §5 PR-9). Card
 * state is stored field for field (`learner.review_card`), so it is never
 * re-derived from attempts. Parameters are the library defaults with fuzz
 * off, which keeps every interval reproducible; changing them, or the
 * pinned library, needs a new version string below.
 */

export const ALGORITHM_VERSION = 'ts-fsrs@5.4.2'
export const PARAMS_VERSION = 'fsrs-defaults-nofuzz-v1'

const scheduler = fsrs(generatorParameters({enable_fuzz: false}))

/** One card's scheduler state as stored; `state` is ts-fsrs `State` (0 New … 3 Relearning). */
export type CardState = {
  due: Date
  stability: number
  difficulty: number
  elapsedDays: number
  scheduledDays: number
  learningSteps: number
  reps: number
  lapses: number
  state: number
  lastReview: Date | null
}

function toCard(state: CardState): Card {
  return {
    due: state.due,
    stability: state.stability,
    difficulty: state.difficulty,
    elapsed_days: state.elapsedDays,
    scheduled_days: state.scheduledDays,
    learning_steps: state.learningSteps,
    reps: state.reps,
    lapses: state.lapses,
    state: state.state,
    ...(state.lastReview ? {last_review: state.lastReview} : {}),
  }
}

function fromCard(card: Card): CardState {
  return {
    due: card.due,
    stability: card.stability,
    difficulty: card.difficulty,
    elapsedDays: card.elapsed_days,
    scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    lastReview: card.last_review ?? null,
  }
}

/** A card that has never been rated: due at `now`. */
export function newCardState(now: Date): CardState {
  return fromCard(createEmptyCard(now))
}

/** The card after one rating at `now`. Only Again and Good exist in this policy. */
export function rateCard(state: CardState, rating: typeof AGAIN | typeof GOOD, now: Date): CardState {
  return fromCard(scheduler.next(toCard(state), now, rating as Grade).card)
}

/** JSON for `review_log.previous_state` / `new_state`: ts-fsrs field names, ISO dates. */
export function cardStateJson(state: CardState): {[key: string]: string | number | null} {
  const card = toCard(state)
  return {
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    last_review: card.last_review?.toISOString() ?? null,
  }
}
