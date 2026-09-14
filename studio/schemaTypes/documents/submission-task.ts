import {CodeIcon} from '@sanity/icons'
import {defineArrayMember, defineField, defineType, type ConditionalPropertyCallback} from 'sanity'

import {formatSeconds} from '../objects/chapter'

/**
 * A code task a learner can submit for review (development plan §5 PR-12).
 * It references its lesson; the lesson does not store it. The whole task is
 * shown to the learner: what to build and the criteria the review judges it
 * by. Drafted by `npm run draft:submission-task` (source chunks need their
 * revisions resolved from the transcript), imported by an editor, and served
 * only once approved and published. A cited chunk that later changes hides
 * the task until it is re-drafted.
 */

export const SUBMISSION_TASK_REVIEW_CHECKS = [
  {name: 'instructionsClear', title: 'The instructions say exactly what to build'},
  {name: 'criteriaObservable', title: 'Each criterion can be checked by reading the code'},
  {name: 'alternativesAllowed', title: 'The criteria accept valid alternative approaches (a specific library or pattern is required only on purpose)'},
  {name: 'sourcesSupport', title: 'The cited lesson moments teach what the criteria check'},
  {name: 'conceptsRelevant', title: 'The linked concepts are what the task practises'},
] as const

/** Fields covered by `version`: a published change needs `version + 1` (see `actions/submission-task-publish.ts`). */
export const SUBMISSION_TASK_CONTENT_FIELDS = [
  'lesson',
  'title',
  'instructions',
  'language',
  'criteria',
  'concepts',
  'sourceChunkRefs',
] as const

const lockedWhenApproved: ConditionalPropertyCallback = ({document}) => document?.reviewStatus === 'approved'

export const submissionTask = defineType({
  name: 'submissionTask',
  title: 'Submission task',
  type: 'document',
  icon: CodeIcon,
  description: 'A code task with acceptance criteria, reviewed by a model against those criteria. Created only by `npm run draft:submission-task`.',
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
          return SUBMISSION_TASK_REVIEW_CHECKS.every((check) => review[check.name] === true)
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
      description: 'Increase by one whenever published content changes. Earlier reviews stay tied to their version.',
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
      name: 'instructions',
      type: 'text',
      group: 'task',
      rows: 6,
      description: 'What to build, including the function name and inputs. Shown to the learner as written.',
      readOnly: lockedWhenApproved,
      validation: (rule) => rule.required().max(2000),
    }),
    defineField({
      name: 'language',
      type: 'string',
      group: 'task',
      options: {
        list: [
          {title: 'JavaScript', value: 'javascript'},
          {title: 'TypeScript', value: 'typescript'},
          {title: 'Python', value: 'python'},
          {title: 'SQL', value: 'sql'},
        ],
      },
      readOnly: lockedWhenApproved,
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'criteria',
      title: 'Acceptance criteria',
      type: 'array',
      group: 'task',
      description:
        'Observable statements the review checks, one each. Shown to the learner. The id under each is what findings and learner records refer to.',
      readOnly: lockedWhenApproved,
      of: [
        defineArrayMember({
          name: 'criterion',
          type: 'object',
          fields: [defineField({name: 'text', type: 'string', validation: (rule) => rule.required().max(300)})],
          preview: {
            select: {title: 'text', id: '_key'},
            prepare({title, id}) {
              return {title, subtitle: `id: ${id}`}
            },
          },
        }),
      ],
      validation: (rule) => rule.required().min(1).max(8),
    }),
    defineField({
      name: 'concepts',
      type: 'array',
      group: 'task',
      description: 'Approved concepts the task practises (up to 4). Findings may name them.',
      readOnly: lockedWhenApproved,
      of: [defineArrayMember({type: 'reference', to: [{type: 'concept'}], options: {filter: 'reviewStatus == "approved"', disableNew: true}})],
      validation: (rule) => rule.max(4).unique(),
    }),
    defineField({
      name: 'sourceChunkRefs',
      title: 'Source moments',
      type: 'array',
      group: 'source',
      readOnly: true,
      description: 'Transcript chunks of this lesson that teach the criteria, at the revision reviewed. Findings cite only these.',
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
      validation: (rule) => rule.required().min(1).max(8),
    }),
    defineField({
      name: 'review',
      type: 'object',
      group: 'review',
      description: 'All checks are required before approval and publishing.',
      fields: [
        ...SUBMISSION_TASK_REVIEW_CHECKS.map((check) =>
          defineField({name: check.name, title: check.title, type: 'boolean', initialValue: false}),
        ),
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
