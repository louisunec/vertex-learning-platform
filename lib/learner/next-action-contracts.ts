import {z} from 'zod'

import {MAP_STATES} from '../knowledge-map.ts'
import {
  ACTION_KINDS,
  DELIVERIES,
  NOTICE_CODES,
  PLAN_LIMIT,
  READINESS,
  REASON_CODES,
} from '../next-action.ts'

/**
 * Public contracts of the next-action and goal routes (development plan §5
 * PR-11). Requests are strict: a body naming a learner, a score, or an
 * evidence state is rejected, so the client can never assert what only the
 * server knows. Responses are strict too, and every link must be one of the
 * implemented routes: a lesson page (optionally at `?t=<seconds>`) or the
 * focused review.
 */

const SANITY_ID = /^[A-Za-z0-9._-]{1,128}$/
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const PLAN_HREF = /^\/(?:lessons\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?:\?t=\d{1,6})?|my-learning\/reviews)$/
const MAX_SECONDS = 24 * 60 * 60

/** Plans for the stored goal, or previews another accessible course without saving it. */
export const nextActionRequestSchema = z.strictObject({courseId: z.string().regex(SANITY_ID).optional()})

export type NextActionRequest = z.infer<typeof nextActionRequestSchema>

/** Sets the learner's goal to a published course, chosen by the learner. */
export const goalRequestSchema = z.strictObject({courseId: z.string().regex(SANITY_ID)})

export type GoalRequest = z.infer<typeof goalRequestSchema>

const title = z.string().min(1).max(200)
const count = z.number().int().min(0).max(10_000)
const seconds = z.number().int().min(0).max(MAX_SECONDS)
const conceptId = z.string().min(1).max(128)

const courseSchema = z.strictObject({id: z.string().regex(SANITY_ID), title, slug: z.string().regex(SLUG)})

/** The planned course, with lesson counts from the learner's stored progress. */
const planCourseSchema = courseSchema
  .extend({totalLessons: count, completedLessons: count})
  .refine((course) => course.completedLessons <= course.totalLessons, 'Completed lessons are lessons of the course')

const goalSchema = z.strictObject({kind: z.literal('course'), courseId: z.string().regex(SANITY_ID), setAt: z.iso.datetime()})

const evidenceTraceSchema = z.strictObject({
  conceptId,
  state: z.enum(MAP_STATES),
  independentCorrect: count,
  independentIncorrect: count,
  assistedCorrect: count,
  assistedIncorrect: count,
  latestIndependent: z.strictObject({correct: z.boolean(), at: z.iso.datetime()}).nullable(),
})

const provenanceSchema = z.strictObject({
  policyVersion: z.string().min(1).max(64),
  delivery: z.enum(DELIVERIES),
  evidence: z.array(evidenceTraceSchema).max(20),
  readiness: z.enum(READINESS).nullable(),
  prerequisites: z
    .array(
      z.strictObject({
        conceptId,
        demonstrated: z.boolean(),
        inCourse: z.boolean(),
        state: z.enum(MAP_STATES),
        latestIndependentAt: z.iso.datetime().nullable(),
      }),
    )
    .max(50),
  progress: z
    .strictObject({lessonId: z.string().regex(SANITY_ID), resumeSeconds: z.number().min(0).nullable(), updatedAt: z.string().max(64).nullable()})
    .nullable(),
  sourceChunkIds: z.array(z.string().min(1).max(200)).max(40),
  check: z.strictObject({remaining: count, total: count}).nullable(),
  review: z.strictObject({resumed: z.boolean(), conceptIds: z.array(conceptId).max(10)}).nullable(),
})

export const planItemSchema = z
  .strictObject({
    id: z.string().min(1).max(200),
    kind: z.enum(ACTION_KINDS),
    reasonCode: z.enum(REASON_CODES),
    tier: z.number().int().min(1).max(10),
    title,
    reason: z.string().min(1).max(600),
    actionLabel: z.string().min(1).max(60),
    href: z.string().regex(PLAN_HREF),
    lesson: z
      .strictObject({
        id: z.string().regex(SANITY_ID),
        title,
        slug: z.string().regex(SLUG),
        number: z.number().int().min(1),
        durationSeconds: z.number().min(0).nullable(),
      })
      .nullable(),
    concept: z.strictObject({conceptId, name: title}).nullable(),
    span: z.strictObject({startSeconds: seconds, endSeconds: seconds.nullable()}).nullable(),
    provenance: provenanceSchema,
  })
  .refine((item) => item.span?.endSeconds == null || item.span.endSeconds > item.span.startSeconds, 'A span ends after it starts')
  .refine((item) => (item.kind === 'practise') === (item.href === '/my-learning/reviews'), 'Only practice opens focused review')
  .refine(
    (item) =>
      item.kind === 'practise' ||
      (item.lesson !== null && (item.href === `/lessons/${item.lesson.slug}` || item.href.startsWith(`/lessons/${item.lesson.slug}?`))),
    'Every other item opens its own lesson',
  )
  .refine(
    (item) => item.span === null || item.kind === 'practise' || item.href.endsWith(`?t=${item.span.startSeconds}`),
    'A span is where the link starts',
  )

export type PlanItemResponse = z.infer<typeof planItemSchema>

export const nextActionResponseSchema = z.discriminatedUnion('status', [
  /** The learner hasn't chosen a goal; nothing is inferred. */
  z.strictObject({status: z.literal('no_goal')}),
  /** The stored goal's course is no longer published. */
  z.strictObject({status: z.literal('goal_unavailable'), goal: goalSchema}),
  z.strictObject({
    status: z.literal('ready'),
    /** The stored goal; null when none is stored (a request may still preview a course). */
    goal: goalSchema.nullable(),
    course: planCourseSchema,
    items: z.array(planItemSchema).max(PLAN_LIMIT),
    notices: z.array(z.enum(NOTICE_CODES)).max(NOTICE_CODES.length),
    policyVersion: z.string().min(1).max(64),
  }),
])

export type NextActionResponse = z.infer<typeof nextActionResponseSchema>

export const goalResponseSchema = z.strictObject({goal: goalSchema, course: courseSchema})

export type GoalResponse = z.infer<typeof goalResponseSchema>
