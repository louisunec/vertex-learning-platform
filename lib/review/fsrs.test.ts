import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {describe, it} from 'node:test'

import {ALGORITHM_VERSION, cardStateJson, newCardState, rateCard, type CardState} from './fsrs.ts'
import {AGAIN, GOOD} from './rating.ts'

/**
 * Adapter fixtures against the pinned ts-fsrs (5.4.2, FSRS-6 default
 * weights, fuzz off). The expected values are the library's own outputs,
 * recorded once: a changed library or parameter set fails here before it
 * silently reschedules stored cards. Nothing asserts that every Good
 * lengthens the interval; same-day reviews show it doesn't.
 */

const T0 = new Date('2026-01-05T09:00:00Z')
const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE

type Summary = Pick<CardState, 'state' | 'reps' | 'lapses' | 'scheduledDays' | 'learningSteps'> & {due: string}

function summary(state: CardState): Summary {
  const {state: s, reps, lapses, scheduledDays, learningSteps} = state
  return {due: state.due.toISOString(), state: s, reps, lapses, scheduledDays, learningSteps}
}

const NEW = 0
const LEARNING = 1
const REVIEW = 2
const RELEARNING = 3

describe('ts-fsrs adapter', () => {
  it('pins the installed library version', async () => {
    const pkg = JSON.parse(await readFile(new URL('../../node_modules/ts-fsrs/package.json', import.meta.url), 'utf8'))
    assert.equal(`ts-fsrs@${pkg.version}`, ALGORITHM_VERSION)
  })

  it('creates an unrated New card due immediately', () => {
    assert.deepEqual(summary(newCardState(T0)), {due: T0.toISOString(), state: NEW, reps: 0, lapses: 0, scheduledDays: 0, learningSteps: 0})
    assert.equal(newCardState(T0).lastReview, null)
  })

  it('first review: Good enters the second learning step, Again the first', () => {
    const good = rateCard(newCardState(T0), GOOD, T0)
    assert.deepEqual(summary(good), {due: '2026-01-05T09:10:00.000Z', state: LEARNING, reps: 1, lapses: 0, scheduledDays: 0, learningSteps: 1})
    assert.equal(good.lastReview?.toISOString(), T0.toISOString())
    const again = rateCard(newCardState(T0), AGAIN, T0)
    assert.deepEqual(summary(again), {due: '2026-01-05T09:01:00.000Z', state: LEARNING, reps: 1, lapses: 0, scheduledDays: 0, learningSteps: 0})
  })

  it('graduates to Review, lapses to Relearning on Again, and recovers on Good', () => {
    const g1 = rateCard(newCardState(T0), GOOD, T0)
    const g2 = rateCard(g1, GOOD, g1.due)
    assert.deepEqual(summary(g2), {due: '2026-01-07T09:10:00.000Z', state: REVIEW, reps: 2, lapses: 0, scheduledDays: 2, learningSteps: 0})
    const g3 = rateCard(g2, GOOD, g2.due)
    assert.deepEqual(summary(g3), {due: '2026-01-18T09:10:00.000Z', state: REVIEW, reps: 3, lapses: 0, scheduledDays: 11, learningSteps: 0})
    const lapse = rateCard(g3, AGAIN, g3.due)
    assert.deepEqual(summary(lapse), {due: '2026-01-18T09:20:00.000Z', state: RELEARNING, reps: 4, lapses: 1, scheduledDays: 0, learningSteps: 0})
    const back = rateCard(lapse, GOOD, lapse.due)
    assert.deepEqual(summary(back), {due: '2026-01-20T09:20:00.000Z', state: REVIEW, reps: 5, lapses: 1, scheduledDays: 2, learningSteps: 0})
  })

  it('schedules an overdue Good further out than an on-time one', () => {
    const g1 = rateCard(newCardState(T0), GOOD, T0)
    const g2 = rateCard(g1, GOOD, g1.due)
    const g3 = rateCard(g2, GOOD, g2.due)
    const onTime = rateCard(g3, GOOD, g3.due)
    const overdue = rateCard(g3, GOOD, new Date(g3.due.getTime() + 30 * DAY))
    assert.equal(onTime.scheduledDays, 46)
    assert.equal(overdue.scheduledDays, 89)
  })

  it('handles repeated same-day activity without raising stability', () => {
    const g1 = rateCard(newCardState(T0), GOOD, T0)
    const twoMin = rateCard(g1, GOOD, new Date(T0.getTime() + 2 * MINUTE))
    const fourMin = rateCard(twoMin, GOOD, new Date(T0.getTime() + 4 * MINUTE))
    assert.deepEqual(summary(twoMin), {due: '2026-01-07T09:02:00.000Z', state: REVIEW, reps: 2, lapses: 0, scheduledDays: 2, learningSteps: 0})
    assert.deepEqual(summary(fourMin), {due: '2026-01-08T09:04:00.000Z', state: REVIEW, reps: 3, lapses: 0, scheduledDays: 3, learningSteps: 0})
    assert.equal(fourMin.stability, twoMin.stability)
  })

  it('serializes state with ts-fsrs field names and ISO dates', () => {
    const json = cardStateJson(rateCard(newCardState(T0), GOOD, T0))
    assert.equal(json.due, '2026-01-05T09:10:00.000Z')
    assert.equal(json.last_review, T0.toISOString())
    assert.equal(json.learning_steps, 1)
    assert.equal(cardStateJson(newCardState(T0)).last_review, null)
  })
})
