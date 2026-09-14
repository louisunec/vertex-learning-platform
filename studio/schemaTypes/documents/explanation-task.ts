import {CommentIcon} from '@sanity/icons'
import {defineArrayMember, defineField, defineType, type ConditionalPropertyCallback} from 'sanity'

import {formatSeconds} from '../objects/chapter'

/**
 * An "explain it in your own words" task (development plan §5 PR-8). It
 * references its lesson; the lesson does not store it. Learners see only
 * the title and prompt before answering; each criterion's point is the
 * private rubric the feedback model judges against, and its label is what
 * the learner sees after feedback. Drafted by `npm run draft:explanation-task`
 * (source chunks need their revisions resolved from the transcript),
 * imported by an editor, and served only once approved and published. A
 * cited chunk that later changes, or a criterion concept that is withdrawn,
 * hides the task until it is re-drafted.
 */

export const EXPLANATION_TASK_REVIEW_CHECKS = [
  {name: 'promptNarrow', title: 'The prompt asks about one specific idea a short answer can explain'},
  {name: 'pointsObservable', title: 'Each point can be recognised in a short explanation, in any accurate wording'},
  {name: 'requiredMinimal', title: 'Only the points the prompt truly needs are required; the rest are optional'},
  {name: 'labelsHideAnswer', title: "Each label names the topic without giving the answer away"},
  {name: 'sourcesSupport', title: "Each point's cited lesson moments state what the point says"},
  {name: 'conceptsRelevant', title: "Each point's concept and objective are what it checks"},
] as const

/** Fields covered by `version`: a published change needs `version + 1` (see `actions/explanation-task-publish.ts`). */
export const EXPLANATION_TASK_CONTENT_FIELDS = ['lesson', 'title', 'prompt', 'criteria', 'sourceChunkRefs'] as const

const lockedWhenApproved: ConditionalPropertyCallback = ({document}) => document?.reviewStatus === 'approved'

type CriterionLike = {sourceChunkIds?: string[]}
type TaskLike = {sourceChunkRefs?: Array<{chunkId?: string}>; criteria?: Array<{required?: boolean}>}

export const explanationTask = defineType({
  name: 'explanationTask',
  title: 'Explanation task',
  type: 'document',
  icon: CommentIcon,
  description: 'An explain-it-in-your-own-words task with a private rubric. Created only by `npm run draft:explanation-task`.',
  groups: [
    {name: 'task', title: 'Task', default: true},
    {name: 'review', title: 'Review'},
    {name: 'source', title: 'Source'},
  ],
  fields: [
    defineField({
      name: 'reviewStatus',
      type: 'string',
      group: ['task', 'review'],
      options: {
        list: [
          {title: 'Needs review', value: 'needs_review'},
          {title: 'Approved', value: 'approved'},
          {title: 'Rejected', value: 'rejected'},
          {title: 'Archived', value: 'archived'},
        ],
        layout: 'radio',
        direction: 'horizontal',
      },
      initialValue: 'needs_review',
      description: 'Only approved tasks are shown to learners. Approving locks the content.',
      validation: (rule) =>
        rule.required().custom((value, context) => {
          if (value !== 'approved') return true
          const review = (context.document?.review ?? {}) as Record<string, unknown>
          return EXPLANATION_TASK_REVIEW_CHECKS.every((check) => review[check.name] === true)
            ? true
            : 'Complete every review check before approving.'
        }),
    }),
    defineField({
      name: 'taskId',
      title: 'Task id',
      type: 'string',
      group: 'task',
      readOnly: true,
      description: 'Stable across versions; learner records refer to it.',
      validation: (rule) => rule.required().regex(/^[a-z0-9-]{3,64}$/),
    }),
    defineField({
      name: 'version',
      type: 'number',
      group: 'task',
      initialValue: 1,
      description: 'Increase by one whenever published content changes. Earlier feedback stays tied to its version.',
      validation: (rule) => rule.required().integer().min(1),
    }),
    defineField({
      name: 'lesson',
      type: 'reference',
      group: 'task',
      to: [{type: 'lesson'}],
      readOnly: true,
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'title',
      type: 'string',
      group: 'task',
      readOnly: lockedWhenApproved,
      validation: (rule) => rule.required().max(120),
    }),
    defineField({
      name: 'prompt',
      type: 'text',
      group: 'task',
      rows: 3,
      description: 'The question the learner answers in their own words. Shown as written; one specific idea, not a whole lesson.',
      readOnly: lockedWhenApproved,
      validation: (rule) => rule.required().max(600),
    }),
    defineField({
      name: 'criteria',
      title: 'Points',
      type: 'array',
      group: 'task',
      description:
        'What an accurate explanation conveys, one point each. Feedback judges each point separately; the id under each is what learner records refer to.',
      readOnly: lockedWhenApproved,
      of: [
        defineArrayMember({
          name: 'explanationCriterion',
          title: 'Point',
          type: 'object',
          fields: [
            defineField({
              name: 'label',
              type: 'string',
              description: 'Shown to the learner after feedback. Name the topic; do not state the answer.',
              validation: (rule) => rule.required().max(120),
            }),
            defineField({
              name: 'point',
              type: 'text',
              rows: 3,
              description: 'Private rubric: what an accurate explanation conveys. Never shown to learners.',
              validation: (rule) => rule.required().max(400),
            }),
            defineField({name: 'required', type: 'boolean', initialValue: true, validation: (rule) => rule.required()}),
            defineField({
              name: 'concept',
              type: 'reference',
              to: [{type: 'concept'}],
              options: {filter: 'reviewStatus == "approved"', disableNew: true},
              validation: (rule) => rule.required(),
            }),
            defineField({
              name: 'objectiveKey',
              title: 'Objective id',
              type: 'string',
              description: "Optional: the id of the concept's objective this point assesses.",
              validation: (rule) => rule.max(64),
            }),
            defineField({
              name: 'sourceChunkIds',
              title: 'Source moments',
              type: 'array',
              readOnly: true,
              of: [defineArrayMember({type: 'string'})],
              description: "Chunk ids from this task's source moments that teach the point.",
              validation: (rule) =>
                rule
                  .required()
                  .min(1)
                  .max(6)
                  .custom((value, context) => {
                    const known = new Set(((context.document as TaskLike | undefined)?.sourceChunkRefs ?? []).map((ref) => ref.chunkId))
                    return ((value as CriterionLike['sourceChunkIds']) ?? []).every((id) => known.has(id))
                      ? true
                      : "Every source must be one of the task's source moments."
                  }),
            }),
          ],
          preview: {
            select: {title: 'label', required: 'required', id: '_key'},
            prepare({title, required, id}) {
              return {title, subtitle: `${required ? 'required' : 'optional'} · id: ${id}`}
            },
          },
        }),
      ],
      validation: (rule) =>
        rule
          .required()
          .min(1)
          .max(5)
          .custom((value) =>
            ((value as TaskLike['criteria']) ?? []).some((criterion) => criterion.required) ? true : 'At least one point must be required.',
          ),
    }),
    defineField({
      name: 'sourceChunkRefs',
      title: 'Source moments',
      type: 'array',
      group: 'source',
      readOnly: true,
      description: 'Transcript chunks of this lesson that teach the points, at the revision reviewed. Feedback cites only these.',
      of: [
        defineArrayMember({
          name: 'sourceChunkRef',
          type: 'object',
          fields: [
            defineField({name: 'chunkId', type: 'string'}),
            defineField({name: 'chunkRevision', type: 'string'}),
            defineField({name: 'startSeconds', type: 'number'}),
            defineField({name: 'endSeconds', type: 'number'}),
          ],
          preview: {
            select: {chunkId: 'chunkId', start: 'startSeconds', end: 'endSeconds'},
            prepare({chunkId, start, end}) {
              return {title: `${formatSeconds(start)}–${formatSeconds(end)}`, subtitle: chunkId}
            },
          },
        }),
      ],
      validation: (rule) => rule.required().min(1).max(10),
    }),
    defineField({
      name: 'review',
      type: 'object',
      group: 'review',
      description: 'All checks are required before approval and publishing.',
      fields: [
        ...EXPLANATION_TASK_REVIEW_CHECKS.map((check) => defineField({name: check.name, title: check.title, type: 'boolean', initialValue: false})),
        defineField({name: 'note', title: 'Reviewer note', type: 'text', rows: 2}),
      ],
    }),
  ],
  preview: {
    select: {title: 'title', reviewStatus: 'reviewStatus', version: 'version', lesson: 'lesson.title'},
    prepare({title, reviewStatus, version, lesson}) {
      return {
        title: title || 'Untitled task',
        subtitle: [(reviewStatus ?? 'needs_review').replace('_', ' '), version ? `v${version}` : null, lesson].filter(Boolean).join(' · '),
      }
    },
  },
})
