import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {after, before, beforeEach, describe, it} from 'node:test'

import {AiCallError} from '../ai/gateway.ts'
import type {HelpMode, HelpRequestKind} from '../ai/help-policy.ts'
import {CLARIFYING_QUESTION, INSUFFICIENT_EVIDENCE_MESSAGE} from '../ai/tutor.ts'
import {asLearner} from '../db/learner-scope.ts'
import {createTestDatabase, SKIP_WITHOUT_DATABASE, type TestDatabase} from '../db/test-db.ts'
import {pauseAfterQuery} from '../db/test-interleave.ts'
import {submitAttempt} from '../learner/attempts.ts'
import type {TutorResponse} from '../learner/contracts.ts'
import {requestHelp} from '../learner/help.ts'
import {issueTask} from '../learner/task-instances.ts'
import {FixtureContent} from '../learner/test-content.ts'
import {askTutor, type AskTutorOutcome} from './service.ts'
import {citingModel, failingModel, FixtureTutorSource, scriptedModel, tutorModel} from './test-source.ts'

/**
 * The tutor service against a real Postgres under the app role
 * (development plan §5 PR-6 acceptance): authorization, help-level
 * progression and retries, what is recorded for each outcome, the budget,
 * and how tutor help on a task reaches grading. The model is a local mock.
 */

const ALICE = 'user_alice'
const BOB = 'user_bob'
const NOW = new Date('2026-09-13T10:00:00.000Z')

const key = () => `key-${randomUUID().replaceAll('-', '')}`

type Ask = {
  learnerId?: string
  question?: string
  currentSeconds?: number
  lessonId?: string
  mode?: HelpMode
  helpRequest?: HelpRequestKind
  sessionId?: string
  taskInstanceId?: string
  requestKey?: string
}

describe('tutor service', {skip: SKIP_WITHOUT_DATABASE}, () => {
  let db: TestDatabase
  let content: FixtureContent
  let source: FixtureTutorSource
  let model: ReturnType<typeof citingModel>

  before(async () => {
    db = await createTestDatabase()
  })
  after(() => db?.drop())

  beforeEach(async () => {
    await db.sql`truncate learner.review_session_item, learner.review_session, learner.tutor_request, learner.event_outbox, learner.concept_mastery, learner.help_event, learner.attempt_log, learner.task_instance`
    content = new FixtureContent()
    content.concepts.set('concept-cpt-state', {id: 'concept-cpt-state', conceptId: 'cpt-state', reviewStatus: 'approved'})
    source = new FixtureTutorSource()
    model = citingModel()
  })

  function ask(
    {learnerId = ALICE, question = 'What does useState return?', currentSeconds = 110, lessonId = 'lesson-hooks', mode = 'study', ...rest}: Ask = {},
    options: {model?: Parameters<typeof askTutor>[0]['model']; requestsPerHour?: number} = {},
  ): Promise<AskTutorOutcome> {
    return askTutor({
      db: db.sql,
      source,
      model: 'model' in options ? (options.model ?? null) : model,
      learnerId,
      requestsPerHour: options.requestsPerHour,
      request: {lessonId, currentSeconds, question, mode, requestKey: rest.requestKey ?? key(), ...rest},
    })
  }

  const answered = (outcome: AskTutorOutcome): TutorResponse => {
    assert.equal(outcome.status, 'answered', JSON.stringify(outcome))
    return outcome.status === 'answered' ? outcome.body : assert.fail()
  }

  async function issue(learnerId = ALICE): Promise<string> {
    const outcome = await issueTask({db: db.sql, content, learnerId, assessmentId: content.addItem('fam1'), now: NOW})
    assert.equal(outcome.status, 'issued')
    return outcome.status === 'issued' ? outcome.body.taskInstanceId : ''
  }

  const counts = async () => {
    const [row] = await db.sql<{requests: number; events: number; outbox: number}[]>`
      select
        (select count(*)::int from learner.tutor_request) as requests,
        (select count(*)::int from learner.help_event) as events,
        (select count(*)::int from learner.event_outbox) as outbox
    `
    return {...row}
  }

  it('answers with server-built citations and records ids and enums only', async () => {
    const body = answered(await ask({sessionId: 'session-aaaaaaaa'}))
    assert.equal(body.status, 'supported')
    assert.equal(body.scope, 'lesson')
    assert.deepEqual(body.help && {level: body.help.level, reasonCode: body.help.reasonCode}, {level: 1, reasonCode: 'first_help'})
    const [pointer] = body.statements.filter((statement) => statement.kind === 'pointer')
    assert.match(pointer.citations[0].href, /^\/lessons\/react-hooks\?t=\d+$/)
    // The answer and its support check: retrieval terms take no model call.
    assert.equal(model.calls, 1)
    assert.equal(model.doGenerateCalls.length, 2)

    const [request] = await db.sql`select * from learner.tutor_request`
    assert.deepEqual(
      {
        lesson: request.lesson_id,
        status: request.status,
        scope: request.scope,
        cited: request.cited_count,
        help: request.help_event_id,
        session: request.session_id,
        model: request.model_id,
      },
      {lesson: 'lesson-hooks', status: 'supported', scope: 'lesson', cited: 1, help: body.help?.helpEventId, session: 'session-aaaaaaaa', model: 'mock-model-id'},
    )
    assert.ok(request.evidence_count > 0)

    const outbox = await db.sql<{event_type: string; payload: Record<string, unknown>}[]>`
      select event_type, payload from learner.event_outbox order by event_type
    `
    assert.deepEqual(
      outbox.map((row) => row.event_type),
      ['help_level_decided', 'tutor_answered'],
    )
    const serialized = JSON.stringify(outbox)
    for (const text of ['useState', 'What does', 'instructor', 'renders']) assert.equal(serialized.includes(text), false, text)
    assert.deepEqual(Object.keys(outbox[1].payload).toSorted(), [
      'citedCount',
      'droppedStatements',
      'evidenceCount',
      'helpEventId',
      'learnerId',
      'lessonId',
      'promptVersion',
      'scope',
      'status',
      'supportCheck',
      'taskInstanceId',
      'tutorRequestId',
    ])
    assert.deepEqual([outbox[1].payload.supportCheck, outbox[1].payload.promptVersion], ['tutor-support-v3', 'tutor-v5'])
  })

  it('rejects a replayed key without a second model call or escalation', async () => {
    const requestKey = key()
    answered(await ask({requestKey, helpRequest: 'escalate', sessionId: 'session-bbbbbbbb'}))
    assert.deepEqual(await ask({requestKey, helpRequest: 'escalate', sessionId: 'session-bbbbbbbb'}), {status: 'rejected', code: 'already_answered'})
    assert.equal(model.calls, 1)
    assert.deepEqual(await counts(), {requests: 1, events: 1, outbox: 2})
  })

  it('reports already_answered when the same request commits between the replay checks', async () => {
    // The first replay check misses the key; the duplicate then commits its tutor request and help
    // event together. The retry is a replay of this tutor request, not a key reused for other help.
    const requestKey = key()
    const request = {lessonId: 'lesson-hooks', currentSeconds: 110, question: 'What does useState return?', mode: 'study' as const, sessionId: 'session-cccccccc', requestKey}
    let first: AskTutorOutcome | undefined
    const interleaved = pauseAfterQuery(db.sql, 'and request_key =', async () => {
      first = await askTutor({db: db.sql, source, model, learnerId: ALICE, request})
    })
    const retry = await askTutor({db: interleaved, source, model, learnerId: ALICE, request})
    assert.equal(interleaved.paused(), true)
    assert.equal(first?.status, 'answered')
    assert.deepEqual(retry, {status: 'rejected', code: 'already_answered'})
    assert.deepEqual(await counts(), {requests: 1, events: 1, outbox: 2})
  })

  it('rejects a key already used for task help', async () => {
    const taskInstanceId = await issue()
    const requestKey = key()
    const helped = await requestHelp({db: db.sql, content, learnerId: ALICE, request: {taskInstanceId, mode: 'study', request: 'hint', requestKey}})
    assert.equal(helped.status, 'helped')
    assert.deepEqual(await ask({requestKey}), {status: 'rejected', code: 'idempotency_key_reused'})
    assert.equal(model.calls, 0)
  })

  it('escalates within a session only on request, and restarts in a new session', async () => {
    const level = async (extra: Ask) => answered(await ask(extra)).help?.level
    const session = 'session-cccccccc'
    assert.equal(await level({sessionId: session}), 1)
    assert.equal(await level({sessionId: session}), 1)
    assert.equal(await level({sessionId: session, helpRequest: 'escalate'}), 2)
    assert.equal(await level({sessionId: session, helpRequest: 'escalate'}), 3)
    assert.equal(await level({sessionId: session, helpRequest: 'escalate'}), 3)
    assert.equal(await level({sessionId: 'session-dddddddd'}), 1)
    assert.equal(await level({}), 1)
    assert.equal(await level({mode: 'reference'}), 3)
    assert.equal(await level({helpRequest: 'solution'}), 3)
  })

  it("rejects another learner's task and a task from another lesson, recording nothing", async () => {
    const bobs = await issue(BOB)
    assert.deepEqual(await ask({taskInstanceId: bobs}), {status: 'rejected', code: 'not_found'})
    const alices = await issue()
    assert.deepEqual(await ask({taskInstanceId: alices, lessonId: 'lesson-effects', currentSeconds: 60}), {status: 'rejected', code: 'not_found'})
    assert.equal(model.calls, 0)
    assert.deepEqual(await counts(), {requests: 0, events: 0, outbox: 0})
  })

  it('rejects an unpublished lesson and a playhead past the video', async () => {
    assert.deepEqual(await ask({lessonId: 'drafts.lesson-hooks'}), {status: 'rejected', code: 'not_found'})
    assert.deepEqual(await ask({currentSeconds: 601}), {status: 'rejected', code: 'invalid_request'})
    assert.equal(answered(await ask({currentSeconds: 600})).status, 'supported')
  })

  it('records task help on the instance, so a later answer counts as assisted', async () => {
    const taskInstanceId = await issue()
    const body = answered(await ask({taskInstanceId, mode: 'reference'}))
    assert.deepEqual([body.help?.level, body.help?.reasonCode], [3, 'reference_mode'])
    const [event] = await db.sql`select task_instance_id, family_id, level from learner.help_event`
    assert.deepEqual({...event}, {task_instance_id: taskInstanceId, family_id: 'fam1', level: 3})

    const graded = await submitAttempt({db: db.sql, content, learnerId: ALICE, request: {taskInstanceId, optionId: 'opt-a', idempotencyKey: key()}, now: NOW})
    assert.equal(graded.status, 'graded')
    assert.deepEqual(graded.status === 'graded' && graded.body.evidence, {kind: 'assisted', reasonCode: 'answer_exposed'})
  })

  it('continues the task ladder shared with /api/help', async () => {
    const taskInstanceId = await issue()
    const helped = await requestHelp({db: db.sql, content, learnerId: ALICE, request: {taskInstanceId, mode: 'study', request: 'hint', requestKey: key()}})
    assert.equal(helped.status === 'helped' && helped.body.level, 1)
    assert.equal(answered(await ask({taskInstanceId, helpRequest: 'escalate'})).help?.level, 2)
  })

  it('records nothing when the model or the support check fails, and reports it as retryable', async () => {
    const failing = failingModel()
    await assert.rejects(ask({}, {model: failing}), (error) => error instanceof AiCallError && error.category === 'provider_error')
    await assert.rejects(ask({}, {model: null}), AiCallError)
    const failingCheck = tutorModel({
      support: () => {
        throw new Error('checker down')
      },
    })
    await assert.rejects(ask({}, {model: failingCheck}), (error) => error instanceof AiCallError && error.category === 'provider_error')
    assert.equal(failingCheck.calls, 1)
    assert.deepEqual(await counts(), {requests: 0, events: 0, outbox: 0})
  })

  it('never delivers help from claims the support check rejects', async () => {
    const taskInstanceId = await issue()
    const rejecting = tutorModel({support: (input) => ({verdicts: input.items.map((item) => ({id: item.id, verdict: 'not_supported'})), guidingQuestionRevealsAnswer: false})})
    const body = answered(await ask({taskInstanceId}, {model: rejecting}))
    assert.deepEqual([body.status, body.help, body.statements], ['insufficient_evidence', null, []])
    const [event] = await db.sql`select count(*)::int as n from learner.help_event`
    assert.equal(event.n, 0, 'no help recorded, so the task is not marked assisted')
  })

  it('answers level 1 with pointers and a guiding question, never a claim', async () => {
    const body = answered(await ask({sessionId: 'session-eeeeeeee'}))
    assert.equal(body.help?.level, 1)
    assert.deepEqual(body.statements.map((statement) => statement.kind), ['pointer', 'connective'])
    assert.match(body.statements[0].text, /^This is covered in React hooks · \d+:\d{2}\.$/)
  })

  it('records a request but no help when the evidence is insufficient', async () => {
    const offTopic = answered(await ask({lessonId: 'lesson-reading', currentSeconds: 0, question: 'Explain quantum chromodynamics'}))
    assert.deepEqual(offTopic, {
      tutorRequestId: offTopic.tutorRequestId,
      status: 'insufficient_evidence',
      scope: 'course',
      statements: [],
      message: INSUFFICIENT_EVIDENCE_MESSAGE,
      help: null,
    })
    assert.equal(model.calls, 0)

    const refused = scriptedModel(() => ({status: 'insufficient_evidence', statements: [], followUp: null}))
    const said = answered(await ask({mode: 'reference'}, {model: refused}))
    assert.deepEqual([said.status, said.help, refused.calls], ['insufficient_evidence', null, 1])

    assert.deepEqual(await counts(), {requests: 2, events: 0, outbox: 2})
    const rows = await db.sql`select status, model_id from learner.tutor_request order by created_at`
    assert.deepEqual(rows.map((row) => [row.status, row.model_id]), [['insufficient_evidence', null], ['insufficient_evidence', 'mock-model-id']])
  })

  it('asks one clarifying question at level 0 when there is nothing to anchor on', async () => {
    const body = answered(await ask({lessonId: 'lesson-reading', currentSeconds: 0, question: 'help??'}))
    assert.deepEqual([body.status, body.help?.level, body.help?.reasonCode, body.followUp, body.statements], [
      'clarification_needed',
      0,
      'clarification_needed',
      CLARIFYING_QUESTION,
      [],
    ])
    assert.equal(model.calls, 0)
    // A deictic question at a playhead with transcript is answered from the window.
    assert.equal(answered(await ask({question: 'what does this mean?'})).scope, 'window')
  })

  it('enforces the hourly budget per learner', async () => {
    answered(await ask({}, {requestsPerHour: 2}))
    answered(await ask({}, {requestsPerHour: 2}))
    assert.deepEqual(await ask({}, {requestsPerHour: 2}), {status: 'rejected', code: 'rate_limited'})
    answered(await ask({learnerId: BOB}, {requestsPerHour: 2}))
    assert.equal(model.calls, 3)
  })

  it("keeps each learner's tutor requests invisible to the other", async () => {
    answered(await ask())
    answered(await ask({learnerId: BOB}))
    const seen = await asLearner(db.sql, BOB, (tx) => tx<{learner_id: string}[]>`select learner_id from learner.tutor_request`)
    assert.deepEqual(seen.map((row) => row.learner_id), [BOB])
  })
})
