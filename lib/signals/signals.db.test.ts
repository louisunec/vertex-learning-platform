import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {after, before, beforeEach, describe, it} from 'node:test'

import {AiCallError} from '../ai/gateway.ts'
import {recentJobRuns} from '../db/job-run.ts'
import {createTestDatabase, SKIP_WITHOUT_DATABASE, type TestDatabase} from '../db/test-db.ts'
import {askTutor} from '../tutor/service.ts'
import {citingModel, failingModel, FixtureTutorSource} from '../tutor/test-source.ts'
import {evaluateAssessment, readAssessmentAggregates} from './assessment-difficulty.ts'
import {DEFAULT_THRESHOLDS} from './config.ts'
import {loadFixtureReader, type EventReader} from './posthog-reader.ts'
import {listCandidates} from './regenerate.ts'
import {aggregateSignals} from './run.ts'
import {MemorySignalStore} from './sanity-store.ts'
import {addSyntheticLearner} from './synthetic.ts'
import {seedSignalFixture} from './fixture-seed.ts'
import {evaluateTutorGap, readTutorAggregates} from './tutor-gaps.ts'
import {windowContaining} from './windows.ts'

/**
 * Editorial signals against a real Postgres (development plan §5 PR-10).
 * Every learner, attempt, and event here is a labelled fixture in a
 * throwaway database; nothing reaches PostHog or Sanity.
 */

const WINDOW = windowContaining(new Date('2026-09-10T00:00:00Z'), 7)
const IN_WINDOW = new Date('2026-09-09T12:00:00Z')
const FIXTURE = new URL('../../docs/editorial-signals/fixture-events.json', import.meta.url).pathname
const FAMILY = 'asm-1a2b3c4d-s0-q0'
const V1 = `assessment-${FAMILY}-v1`
const V2 = `assessment-${FAMILY}-v2`

type Kind = 'independent' | 'assisted' | 'not_counted'
const REASON: Record<Kind, string> = {independent: 'first_independent_response', assisted: 'hint_used', not_counted: 'repeat_task'}

describe('editorial signals', {skip: SKIP_WITHOUT_DATABASE}, () => {
  let db: TestDatabase

  before(async () => {
    db = await createTestDatabase()
  })
  after(() => db?.drop())

  beforeEach(async () => {
    await db.sql`truncate learner.tutor_request, learner.event_outbox, learner.help_event, learner.attempt_log, learner.task_instance, learner.synthetic_learner, editorial.job_run, editorial.regeneration_candidate`
  })

  /** One graded attempt, inserted as the superuser the way PR-4 records it. */
  async function attempt(learnerId: string, assessmentId: string, version: number, correct: boolean, kind: Kind = 'independent', at: Date = IN_WINDOW) {
    const [instance] = await db.sql<{id: string}[]>`
      insert into learner.task_instance (learner_id, assessment_id, family_id, assessment_version, lesson_id, delivered_option_ids, issued_at, expires_at)
      values (${learnerId}, ${assessmentId}, ${FAMILY}, ${version}, 'lesson-hooks', ${db.sql.array(['opt-a', 'opt-b', 'opt-c'])}, ${at}, ${new Date(at.getTime() + 3_600_000)})
      returning id
    `
    await db.sql`
      insert into learner.attempt_log
        (learner_id, task_instance_id, assessment_id, family_id, assessment_version, selected_option_id, correct,
         hint_level_used, answer_exposed, evidence_kind, evidence_reason, concept_resolution, policy_version,
         idempotency_key, request_hash, created_at)
      values (${learnerId}, ${instance.id}, ${assessmentId}, ${FAMILY}, ${version}, 'opt-a', ${correct},
              ${kind === 'assisted' ? 1 : 0}, false, ${kind}, ${REASON[kind]}, 'none', 'evidence-v1',
              ${`key-${randomUUID().replaceAll('-', '')}`}, 'hash', ${at})
    `
  }

  /** `count` learners answer `version` independently for the first time; the first `incorrect` get it wrong. */
  async function cohort(prefix: string, assessmentId: string, version: number, count: number, incorrect: number) {
    for (let index = 0; index < count; index++) await attempt(`${prefix}_${index}`, assessmentId, version, index >= incorrect)
  }

  describe('assessment difficulty', () => {
    it('uses independent first attempts as the denominator and keeps versions apart', async () => {
      await cohort('user_v2', V2, 2, 25, 18) // 72% of 25: over the threshold
      await cohort('user_v1', V1, 1, 30, 10) // 33% of 30: under
      // Assisted attempts and retries are reported but never enter the rate.
      for (let index = 0; index < 5; index++) await attempt(`user_help_${index}`, V2, 2, false, 'assisted')
      for (let index = 0; index < 4; index++) await attempt(`user_v2_${index}`, V2, 2, true, 'not_counted')

      const rows = await readAssessmentAggregates(db.sql, WINDOW)
      const byId = new Map(rows.map((row) => [row.assessmentId, evaluateAssessment(row, DEFAULT_THRESHOLDS.assessment)]))
      const v2 = byId.get(V2)!
      assert.equal(v2.thresholdMet, true)
      assert.deepEqual(v2.measurement, {
        numerator: 18,
        numeratorLabel: 'Incorrect independent first attempts',
        denominator: 25,
        denominatorLabel: v2.measurement.denominatorLabel,
        rate: 0.72,
        distinctLearners: 25,
      })
      assert.deepEqual(
        Object.fromEntries(v2.supporting.map((metric) => [metric.key, metric.value])),
        {assisted: 5, assisted_incorrect: 5, retries: 4, learners: 30, attempts: 34},
      )
      assert.match(v2.measurement.denominatorLabel, /first response to this assessment family/)
      assert.equal(byId.get(V1)!.thresholdMet, false)
      assert.equal(byId.get(V1)!.measurement.rate, 0.3333)
    })

    it('needs at least 20 eligible attempts, whatever the error rate', async () => {
      await cohort('user_few', V2, 2, 19, 19)
      const [row] = await readAssessmentAggregates(db.sql, WINDOW)
      const candidate = evaluateAssessment(row, DEFAULT_THRESHOLDS.assessment)
      assert.equal(candidate.measurement.rate, 1)
      assert.equal(candidate.thresholdMet, false)
      assert.match(candidate.reason, /needs at least 20/)
    })

    it('counts the window start and excludes the window end', async () => {
      await attempt('user_start', V2, 2, false, 'independent', WINDOW.start)
      await attempt('user_last', V2, 2, false, 'independent', new Date(WINDOW.end.getTime() - 1))
      await attempt('user_end', V2, 2, false, 'independent', WINDOW.end)
      await attempt('user_before', V2, 2, false, 'independent', new Date(WINDOW.start.getTime() - 1))
      const [row] = await readAssessmentAggregates(db.sql, WINDOW)
      assert.equal(row.eligible, 2)
    })

    it('excludes labelled synthetic learners from real aggregates', async () => {
      await cohort('user_demo', V2, 2, 24, 24)
      const [before] = await readAssessmentAggregates(db.sql, WINDOW)
      assert.equal(evaluateAssessment(before, DEFAULT_THRESHOLDS.assessment).thresholdMet, true)
      for (let index = 0; index < 24; index++) await addSyntheticLearner(db.sql, {learnerId: `user_demo_${index}`, label: 'demo'})
      assert.equal((await readAssessmentAggregates(db.sql, WINDOW)).length, 0)
    })
  })

  describe('tutor insufficient evidence', () => {
    const source = new FixtureTutorSource()
    const ask = (learnerId: string, model: Parameters<typeof askTutor>[0]['model'], question = 'Explain quantum chromodynamics') =>
      askTutor({
        db: db.sql,
        source,
        model,
        learnerId,
        request: {lessonId: 'lesson-reading', currentSeconds: 0, question, mode: 'study', requestKey: `key-${randomUUID().replaceAll('-', '')}`},
      })

    it('raises a lesson where several learners got insufficient evidence, and never counts provider failures', async () => {
      // Three learners ask about something no source covers: retrieval ran and found nothing.
      for (const learner of ['user_t1', 'user_t2', 'user_t3']) assert.equal((await ask(learner, citingModel())).status, 'answered')
      // Provider outages on answerable questions: retryable errors, never recorded.
      for (const learner of ['user_t4', 'user_t5', 'user_t6', 'user_t7']) {
        await assert.rejects(
          askTutor({
            db: db.sql,
            source,
            model: failingModel(),
            learnerId: learner,
            request: {lessonId: 'lesson-hooks', currentSeconds: 110, question: 'What does useState return?', mode: 'study', requestKey: `key-${randomUUID().replaceAll('-', '')}`},
          }),
          AiCallError,
        )
      }
      await db.sql`update learner.tutor_request set created_at = ${IN_WINDOW}`

      const {aggregates, buckets} = await readTutorAggregates(db.sql, WINDOW)
      assert.deepEqual(aggregates.map((row) => row.lessonId), ['lesson-reading'], 'the outage left no rows for lesson-hooks')
      const candidate = evaluateTutorGap(aggregates[0], buckets, DEFAULT_THRESHOLDS.tutor)
      assert.equal(candidate.thresholdMet, true)
      assert.equal(candidate.measurement.distinctLearners, 3)
      assert.deepEqual(candidate.timestamp, {startSeconds: 0, endSeconds: 60}, 'the playhead is now recorded with each request')
      assert.match(candidate.reason, /does not show that the course never covers the topic/)
      const [stored] = await db.sql<{current_seconds: number}[]>`select current_seconds from learner.tutor_request limit 1`
      assert.equal(stored.current_seconds, 0)
    })
  })

  describe('a run over the fixture', () => {
    let reader: EventReader
    before(async () => {
      reader = await loadFixtureReader(FIXTURE)
    })

    const seedFixture = () => seedSignalFixture(db.sql)

    const run = (store: MemorySignalStore | null, overrides: Partial<Parameters<typeof aggregateSignals>[0]> = {}) =>
      aggregateSignals({db: db.sql, reader, store, windows: [WINDOW], now: new Date('2026-09-14T06:00:00Z'), workerId: 'test-worker', ...overrides})

    it('raises one signal of each type, labels them as fixtures, and keeps outages out', async () => {
      await seedFixture()
      const store = new MemorySignalStore()
      store.assessments.set(V2, {_id: V2, familyId: FAMILY, version: 2, lessonId: 'lesson-hooks', spanKey: 'span-key-v2'})
      const [report] = await run(store, {recordRun: true})

      const raised = report.planned.filter((entry) => entry.action === 'upsert').map((entry) => [entry.candidate.type, entry.candidate.subjectKey])
      assert.deepEqual(raised.map(([type]) => type).toSorted(), ['assessment_difficulty', 'replay_hotspot', 'search_no_results', 'tutor_insufficient_evidence'])
      assert.ok(raised.some(([type, subject]) => type === 'assessment_difficulty' && subject === V2))
      assert.equal(report.types.search_no_results.excluded?.no_results_degraded, 5)
      assert.equal(report.types.search_no_results.excluded?.unavailable, 3)

      const docs = [...store.documents.values()]
      assert.equal(docs.length, 4)
      for (const doc of docs) {
        assert.equal(doc.fixture, true)
        assert.equal(doc.reviewStatus, 'open')
        assert.match(String(doc.title), /^\[Fixture\] /)
      }
      // No learner identifiers or raw text in anything an instructor sees.
      const visible = JSON.stringify(docs)
      for (const secret of ['fixture_', 'fixture-person', 'How do I', 'kubernetes']) assert.equal(visible.includes(secret), false, secret)
      // The synthetic accounts' v3 would have raised its own signal.
      assert.equal(report.planned.some((entry) => entry.candidate.subjectKey.endsWith('-v3')), false)

      const [queued] = report.regeneration
      assert.equal(queued.result.status, 'queued')
      const [runRecord] = await recentJobRuns(db.sql, 'signal_aggregation')
      assert.equal(runRecord.status, 'succeeded')
    })

    it('is idempotent: a rerun replaces metrics, keeps reviews, and queues no second candidate the same day', async () => {
      await seedFixture()
      const store = new MemorySignalStore()
      store.assessments.set(V2, {_id: V2, familyId: FAMILY, version: 2, lessonId: 'lesson-hooks', spanKey: 'span-key-v2'})
      await run(store)
      const snapshot = structuredClone(Object.fromEntries(store.documents))
      const [assessmentId] = [...store.documents.keys()].filter((id) => id.startsWith('contentSignal-assessment-'))
      store.documents.get(assessmentId)!.reviewStatus = 'investigating'

      const [again] = await run(store)
      assert.deepEqual([...store.documents.keys()].toSorted(), Object.keys(snapshot).toSorted(), 'same documents')
      for (const [id, doc] of store.documents) {
        assert.deepEqual(doc.measurement, snapshot[id].measurement, `${id}: same counts, not doubled`)
      }
      assert.equal(store.documents.get(assessmentId)!.reviewStatus, 'investigating')
      assert.equal(again.regeneration[0].result.status, 'duplicate')
      assert.equal((await listCandidates(db.sql)).length, 1)
    })

    it('caps regeneration candidates per day', async () => {
      await seedFixture()
      const store = new MemorySignalStore()
      store.assessments.set(V2, {_id: V2, familyId: FAMILY, version: 2, lessonId: 'lesson-hooks', spanKey: 'span-key-v2'})
      const [report] = await run(store, {regeneration: {dailyCap: 0}})
      assert.deepEqual(report.regeneration[0].result, {status: 'skipped', reason: 'daily_cap'})
      assert.equal((await listCandidates(db.sql)).length, 0)
    })

    it('still computes the database signals when PostHog is unavailable or failing', async () => {
      await seedFixture()
      const [withoutPostHog] = await run(null, {reader: null})
      assert.equal(withoutPostHog.types.replay_hotspot.detail, 'posthog_unavailable')
      assert.equal(withoutPostHog.types.search_no_results.status, 'skipped')
      assert.equal(withoutPostHog.types.assessment_difficulty.raised, 1)
      assert.equal(withoutPostHog.types.tutor_insufficient_evidence.raised, 1)

      const broken: EventReader = {
        kind: 'posthog',
        readEvents: async () => {
          throw new Error('PostHog query failed: HTTP 503')
        },
      }
      const [failing] = await run(null, {reader: broken})
      assert.equal(failing.types.replay_hotspot.status, 'failed')
      assert.equal(failing.types.search_no_results.status, 'failed')
      assert.equal(failing.types.assessment_difficulty.status, 'ok')
      assert.equal(failing.planned.length, 2)
    })

    it('writes nothing in a dry run', async () => {
      await seedFixture()
      const [report] = await run(null)
      assert.equal(report.planned.length, 4)
      assert.equal(report.regeneration.length, 0)
      assert.equal((await listCandidates(db.sql)).length, 0)
      assert.equal((await recentJobRuns(db.sql, 'signal_aggregation')).length, 0)
    })
  })
})
