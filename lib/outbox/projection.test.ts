import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {OUTBOX_EVENT_SOURCE, PROJECTED_EVENT_TYPES, projectOutboxRow, type OutboxRow} from './projection.ts'

/**
 * The analytics allowlist (development plan §5 PR-10): payloads are the
 * exact shapes PR-4/5/6 write (`attempts.ts`, `help.ts`, `tutor/service.ts`),
 * and PR-12's `submission_reviewed` (`lib/submissions/service.ts` at 54ec90c).
 */

const LEARNER = 'user_2abcDEF'
const CREATED = new Date('2026-09-14T01:02:03.456Z')

const row = (eventType: string, payload: Record<string, unknown>): OutboxRow => ({
  id: '0b8f7e0c-6a2f-4c51-9c47-3f1c2d9e8a10',
  eventType,
  payload,
  createdAt: CREATED,
})

const ATTEMPT = {
  attemptId: '6b1f0f7e-1111-4c51-9c47-3f1c2d9e8a10',
  learnerId: LEARNER,
  assessmentId: 'assessment-asm-1a2b3c4d-s0-q0-v2',
  familyId: 'asm-1a2b3c4d-s0-q0',
  assessmentVersion: 2,
  conceptId: 'cpt-state',
  correct: false,
  evidenceKind: 'independent',
  evidenceReason: 'first_independent_response',
  policyVersion: 'evidence-v1',
}
const HELP = {
  helpEventId: '7c1f0f7e-2222-4c51-9c47-3f1c2d9e8a10',
  learnerId: LEARNER,
  taskInstanceId: '8d1f0f7e-3333-4c51-9c47-3f1c2d9e8a10',
  familyId: 'asm-1a2b3c4d-s0-q0',
  sessionId: 'session-abcdefghijkl',
  level: 2,
  reasonCode: 'escalation',
  explicitOverride: false,
  policyVersion: 'help-v1',
}
const TUTOR = {
  tutorRequestId: '9e1f0f7e-4444-4c51-9c47-3f1c2d9e8a10',
  learnerId: LEARNER,
  lessonId: 'lesson-abc123',
  taskInstanceId: null,
  helpEventId: null,
  status: 'insufficient_evidence',
  scope: 'course',
  evidenceCount: 0,
  citedCount: 0,
  droppedStatements: 0,
  supportCheck: null,
  promptVersion: 'tutor-v5',
}

const SUBMISSION = {
  submissionId: 'af1f0f7e-5555-4c51-9c47-3f1c2d9e8a10',
  learnerId: LEARNER,
  reviewId: 'bf1f0f7e-6666-4c51-9c47-3f1c2d9e8a10',
  taskId: 'hash-a-password',
  taskVersion: 1,
  lessonId: 'lesson-abc123',
  outcome: 'changes_suggested',
  findings: {defect: 1, requirement_mismatch: 1, alternative_valid: 0, uncertain: 0},
  droppedFindings: 0,
  cacheHit: false,
  evidenceKind: 'independent',
  evidenceReason: 'first_independent_response',
  helpLevel: 0,
  helpEventId: 'cf1f0f7e-7777-4c51-9c47-3f1c2d9e8a10',
  promptVersion: 'review-v3',
  checkVersion: 'review-check-v2',
}

/** Every string a property may carry: an id or a short lowercase code, never prose. */
const SAFE_STRING = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

describe('projectOutboxRow', () => {
  it('projects each existing event contract to its allowlisted properties', () => {
    const attempt = projectOutboxRow(row('attempt_graded', ATTEMPT))
    assert.ok(attempt.ok)
    assert.deepEqual(attempt.event, {
      event: 'attempt_graded',
      distinct_id: LEARNER,
      uuid: '0b8f7e0c-6a2f-4c51-9c47-3f1c2d9e8a10',
      timestamp: '2026-09-14T01:02:03.456Z',
      properties: {
        assessment_id: 'assessment-asm-1a2b3c4d-s0-q0-v2',
        family_id: 'asm-1a2b3c4d-s0-q0',
        assessment_version: 2,
        concept_id: 'cpt-state',
        correct: false,
        evidence_kind: 'independent',
        evidence_reason: 'first_independent_response',
        policy_version: 'evidence-v1',
        source: OUTBOX_EVENT_SOURCE,
      },
    })

    const help = projectOutboxRow(row('help_level_decided', HELP))
    assert.ok(help.ok)
    assert.deepEqual(Object.keys(help.event.properties).toSorted(), [
      'explicit_override',
      'family_id',
      'level',
      'policy_version',
      'reason_code',
      'source',
    ])

    const tutor = projectOutboxRow(row('tutor_answered', TUTOR))
    assert.ok(tutor.ok)
    assert.deepEqual(Object.keys(tutor.event.properties).toSorted(), [
      'cited_count',
      'dropped_statements',
      'evidence_count',
      'lesson_id',
      'prompt_version',
      'scope',
      'source',
      'status',
      'support_check',
    ])

    const submission = projectOutboxRow(row('submission_reviewed', SUBMISSION))
    assert.ok(submission.ok)
    assert.deepEqual(submission.event.properties, {
      task_id: 'hash-a-password',
      task_version: 1,
      lesson_id: 'lesson-abc123',
      outcome: 'changes_suggested',
      findings_defect: 1,
      findings_requirement_mismatch: 1,
      findings_alternative_valid: 0,
      findings_uncertain: 0,
      dropped_findings: 0,
      cache_hit: false,
      evidence_kind: 'independent',
      evidence_reason: 'first_independent_response',
      help_level: 0,
      prompt_version: 'review-v3',
      check_version: 'review-check-v2',
      source: OUTBOX_EVENT_SOURCE,
    })
  })

  it('never sends the learner id or internal row ids as properties', () => {
    for (const [type, payload] of [
      ['attempt_graded', ATTEMPT],
      ['help_level_decided', HELP],
      ['tutor_answered', TUTOR],
      ['submission_reviewed', SUBMISSION],
    ] as const) {
      const projected = projectOutboxRow(row(type, payload))
      assert.ok(projected.ok)
      const serialized = JSON.stringify(projected.event.properties)
      for (const secret of [
        LEARNER,
        ATTEMPT.attemptId,
        HELP.helpEventId,
        HELP.taskInstanceId,
        HELP.sessionId,
        TUTOR.tutorRequestId,
        SUBMISSION.submissionId,
        SUBMISSION.reviewId,
        SUBMISSION.helpEventId,
      ]) {
        assert.equal(serialized.includes(secret), false, `${type} leaks ${secret}`)
      }
      for (const value of Object.values(projected.event.properties)) {
        if (typeof value === 'string') assert.match(value, SAFE_STRING, `${type}: ${value}`)
      }
    }
  })

  it('drops fields that are not allowlisted, even when a payload grows', () => {
    const projected = projectOutboxRow(row('attempt_graded', {...ATTEMPT, response: 'my private answer text', explanation: 'x'}))
    assert.ok(projected.ok)
    assert.equal(JSON.stringify(projected.event).includes('private answer'), false)
    const submission = projectOutboxRow(
      row('submission_reviewed', {...SUBMISSION, code: 'const secret = 1', findings: {...SUBMISSION.findings, notes: 'line 3 is wrong'}}),
    )
    assert.ok(submission.ok)
    assert.equal(/secret|line 3/.test(JSON.stringify(submission.event)), false)
  })

  it('rejects prose where a code or id is expected', () => {
    assert.deepEqual(projectOutboxRow(row('help_level_decided', {...HELP, reasonCode: 'The learner asked: how do I hash?'})), {
      ok: false,
      reason: 'invalid_payload',
    })
    assert.deepEqual(projectOutboxRow(row('tutor_answered', {...TUTOR, lessonId: 'lesson with spaces'})), {
      ok: false,
      reason: 'invalid_payload',
    })
    assert.deepEqual(projectOutboxRow(row('attempt_graded', {...ATTEMPT, learnerId: undefined})), {ok: false, reason: 'invalid_payload'})
  })

  it('sends nothing for an event type without an approved projection', () => {
    assert.deepEqual(projectOutboxRow(row('explanation_checked', {learnerId: LEARNER})), {ok: false, reason: 'unknown_event_type'})
    assert.deepEqual(PROJECTED_EVENT_TYPES.toSorted(), ['attempt_graded', 'help_level_decided', 'submission_reviewed', 'tutor_answered'])
  })
})
