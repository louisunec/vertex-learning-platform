import {z} from 'zod'

import {RETRIEVAL_SCOPES, TUTOR_STATUSES} from '../ai/tutor.ts'
import {EVIDENCE_KINDS} from '../learner/evidence.ts'

/**
 * The analytics projection of learner outbox events (development plan §5
 * PR-10). Outbox payloads are the existing event contracts written by PR-4
 * (`attempt_graded`), PR-5 (`help_level_decided`), PR-6 (`tutor_answered`),
 * and PR-12 (`submission_reviewed`); this module decides, per event type, exactly which of
 * their fields may leave the database.
 *
 * - The learner's Clerk id becomes the PostHog `distinct_id` only: it is the
 *   id `components/home/posthog-identity.tsx` already identifies the browser
 *   with, so no new identifier reaches analytics. It is never a property.
 * - Internal row ids (attempt, help event, tutor request, task instance,
 *   session) are dropped: nothing in analytics needs them, and they would
 *   let analytics rows be joined back to private records.
 * - Every property is a number, a boolean, null, a Sanity id, or a short
 *   lowercase code. No learner text exists in these payloads, and the
 *   schemas below reject any string that is not an id or a code.
 * - The event `uuid` is the outbox row id and `timestamp` its `created_at`,
 *   so a resend is identical to the first send: the same `uuid`, `event`,
 *   `timestamp`, and `distinct_id`, the fields PostHog merges duplicates on.
 */

export const OUTBOX_EVENT_SOURCE = 'learner_outbox'

/** A Sanity document id or a stable content id (`asm-…`, `cpt-…`). */
const contentId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
/** A version or policy code such as `evidence-v1` or `tutor-support-v3`. */
const code = z.string().regex(/^[a-z0-9][a-z0-9_.:-]{0,63}$/)
/** Clerk user ids (`user_…`); only ever used as the distinct id. */
const learnerId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const count = z.number().int().min(0).max(1000)

const attemptGraded = z.object({
  learnerId,
  assessmentId: contentId,
  familyId: contentId,
  assessmentVersion: z.number().int().min(1),
  conceptId: contentId.nullable(),
  correct: z.boolean(),
  evidenceKind: z.enum(EVIDENCE_KINDS),
  // Reason codes are open sets that later PRs extend; any code is safe to send.
  evidenceReason: code,
  policyVersion: code,
})

const helpLevelDecided = z.object({
  learnerId,
  familyId: contentId.nullable(),
  level: z.number().int().min(0).max(3),
  reasonCode: code,
  explicitOverride: z.boolean(),
  policyVersion: code,
})

const tutorAnswered = z.object({
  learnerId,
  lessonId: contentId,
  status: z.enum(TUTOR_STATUSES),
  scope: z.enum(RETRIEVAL_SCOPES),
  evidenceCount: count,
  citedCount: count,
  droppedStatements: count,
  supportCheck: code.nullable(),
  promptVersion: code,
})

/**
 * PR-12's `submission_reviewed` (`lib/submissions/service.ts` on
 * `feat/pr-12-submission-review`). The submission, review, and help-event
 * row ids are dropped; the submitted code and the review's findings never
 * enter the payload. The review is model-assisted and provisional, never a
 * grade. Codes stay open-ended (`code`) so a new outcome or reason in PR-12
 * is sent rather than rejected; the finding counts are the four categories
 * PR-12 defines, and any new category is not sent until added here.
 */
const submissionReviewed = z.object({
  learnerId,
  taskId: contentId,
  taskVersion: z.number().int().min(1),
  lessonId: contentId,
  outcome: code,
  findings: z.object({defect: count, requirement_mismatch: count, alternative_valid: count, uncertain: count}),
  droppedFindings: count,
  cacheHit: z.boolean(),
  evidenceKind: z.enum(EVIDENCE_KINDS),
  evidenceReason: code,
  helpLevel: z.number().int().min(0).max(3),
  promptVersion: code,
  checkVersion: code,
})

type Properties = Record<string, string | number | boolean | null>

const PROJECTIONS: Record<string, (payload: unknown) => {learnerId: string; properties: Properties}> = {
  attempt_graded(payload) {
    const p = attemptGraded.parse(payload)
    return {
      learnerId: p.learnerId,
      properties: {
        assessment_id: p.assessmentId,
        family_id: p.familyId,
        assessment_version: p.assessmentVersion,
        concept_id: p.conceptId,
        correct: p.correct,
        evidence_kind: p.evidenceKind,
        evidence_reason: p.evidenceReason,
        policy_version: p.policyVersion,
      },
    }
  },
  help_level_decided(payload) {
    const p = helpLevelDecided.parse(payload)
    return {
      learnerId: p.learnerId,
      properties: {
        family_id: p.familyId,
        level: p.level,
        reason_code: p.reasonCode,
        explicit_override: p.explicitOverride,
        policy_version: p.policyVersion,
      },
    }
  },
  tutor_answered(payload) {
    const p = tutorAnswered.parse(payload)
    return {
      learnerId: p.learnerId,
      properties: {
        lesson_id: p.lessonId,
        status: p.status,
        scope: p.scope,
        evidence_count: p.evidenceCount,
        cited_count: p.citedCount,
        dropped_statements: p.droppedStatements,
        support_check: p.supportCheck,
        prompt_version: p.promptVersion,
      },
    }
  },
  submission_reviewed(payload) {
    const p = submissionReviewed.parse(payload)
    return {
      learnerId: p.learnerId,
      properties: {
        task_id: p.taskId,
        task_version: p.taskVersion,
        lesson_id: p.lessonId,
        outcome: p.outcome,
        findings_defect: p.findings.defect,
        findings_requirement_mismatch: p.findings.requirement_mismatch,
        findings_alternative_valid: p.findings.alternative_valid,
        findings_uncertain: p.findings.uncertain,
        dropped_findings: p.droppedFindings,
        cache_hit: p.cacheHit,
        evidence_kind: p.evidenceKind,
        evidence_reason: p.evidenceReason,
        help_level: p.helpLevel,
        prompt_version: p.promptVersion,
        check_version: p.checkVersion,
      },
    }
  },
}

/**
 * The event types the dispatcher may claim. Any other type stays `pending`,
 * unclaimed and with its attempt budget intact, and is reported as held by
 * `npm run outbox -- status` until a projection is added here: it is never
 * sent, dropped, dead-lettered, or marked delivered.
 */
export const PROJECTED_EVENT_TYPES = Object.keys(PROJECTIONS)

/** One event in PostHog's batch capture format. */
export type CaptureEvent = {
  event: string
  distinct_id: string
  properties: Properties
  uuid: string
  timestamp: string
}

export type OutboxRow = {id: string; eventType: string; payload: unknown; createdAt: Date}

export type Projection =
  | {ok: true; learnerId: string; event: CaptureEvent}
  | {ok: false; reason: 'unknown_event_type' | 'invalid_payload'}

/** The learner id a row belongs to, for synthetic-learner suppression, or null when the payload has none. */
export function outboxLearnerId(payload: unknown): string | null {
  const parsed = z.object({learnerId}).safeParse(payload)
  return parsed.success ? parsed.data.learnerId : null
}

export function projectOutboxRow(row: OutboxRow): Projection {
  const project = PROJECTIONS[row.eventType]
  if (!project) return {ok: false, reason: 'unknown_event_type'}
  let projected: ReturnType<typeof project>
  try {
    projected = project(row.payload)
  } catch {
    return {ok: false, reason: 'invalid_payload'}
  }
  return {
    ok: true,
    learnerId: projected.learnerId,
    event: {
      event: row.eventType,
      distinct_id: projected.learnerId,
      properties: {...projected.properties, source: OUTBOX_EVENT_SOURCE},
      uuid: row.id,
      timestamp: row.createdAt.toISOString(),
    },
  }
}
