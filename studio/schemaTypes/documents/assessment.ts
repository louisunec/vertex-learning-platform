import {ClipboardIcon} from '@sanity/icons'
import {defineArrayMember, defineField, defineType, type ConditionalPropertyCallback} from 'sanity'

import {formatSeconds} from '../objects/chapter'

/**
 * One immutable version of a practice item (development plan §5 PR-1).
 * Drafted by `npm run generate:assessments` as `drafts.assessment-<familyId>-v<n>`
 * and published only after editorial review. The generator is the only way
 * to create one: the Studio offers no create or duplicate action, because
 * source chunk refs are resolved server-side and are read-only here. Answer key, hints, source
 * excerpt, and generation metadata are private: the learner projection
 * (`sanity/queries/assessments.ts`) never selects them.
 */

export const REVIEW_CHECKS = [
  {name: 'correct', title: 'The marked answer is correct'},
  {name: 'unambiguous', title: 'The question has exactly one defensible answer'},
  {name: 'distractorsPlausible', title: 'Distractors are plausible and clearly wrong'},
  {name: 'sourceSupported', title: 'The source excerpt supports the answer'},
  {name: 'difficultyAppropriate', title: 'Difficulty fits the lesson'},
  {
    name: 'hintsProgressive',
    title: 'Hints 1–2 neither state nor paraphrase the answer (the automated check is a heuristic only)',
  },
] as const

/** Fields frozen once a version is approved and published (see `actions/assessment-publish.ts`). */
export const ASSESSMENT_CONTENT_FIELDS = [
  'familyId',
  'version',
  'lesson',
  'objective',
  'type',
  'responseFormat',
  'question',
  'options',
  'answerKey',
  'hints',
  'sourceChunkRefs',
  'sourceExcerpt',
] as const

const lockedWhenApproved: ConditionalPropertyCallback = ({document}) => document?.reviewStatus === 'approved'

type AssessmentLike = {
  options?: Array<{_key?: string; text?: string}>
  answerKey?: {correctOptionId?: string}
}

function normalize(value: unknown): string {
  return typeof value === 'string'
    ? value
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
    : ''
}

const ANSWER_PHRASES = /\b(the (correct )?answer is|correct (option|answer|choice) is|option [a-d]\b|answer [a-d]\b)/i

/**
 * Mirrors the verbatim part of `detectHintLeak` in `lib/assessments/generate.ts`
 * (the Studio cannot import web `lib/`). The paraphrase heuristic stays
 * generator-only so it never blocks a reviewer's judgement.
 */
function hintLeaksAnswer(hint: unknown, document: AssessmentLike | undefined): boolean {
  if (typeof hint !== 'string') return false
  if (ANSWER_PHRASES.test(hint)) return true
  const correct = document?.options?.find((option) => option._key === document.answerKey?.correctOptionId)
  const answer = normalize(correct?.text)
  return answer.length > 0 && ` ${normalize(hint)} `.includes(` ${answer} `)
}

const earlyHint = (name: string, title: string, description: string) =>
  defineField({
    name,
    title,
    type: 'text',
    rows: 2,
    description,
    validation: (rule) =>
      rule.required().custom((value, context) =>
        hintLeaksAnswer(value, context.document as AssessmentLike | undefined)
          ? 'This hint reveals the correct option. Only the solution may.'
          : true,
      ),
  })

export const assessment = defineType({
  name: 'assessment',
  title: 'Assessment',
  type: 'document',
  icon: ClipboardIcon,
  description:
    'Single-choice practice item, created only by `npm run generate:assessments`. Counts as recognition/application evidence, not proof of unconstrained recall or transfer.',
  groups: [
    {name: 'item', title: 'Item', default: true},
    {name: 'review', title: 'Review'},
    {name: 'source', title: 'Source'},
    {name: 'generation', title: 'Generation'},
  ],
  fields: [
    defineField({
      name: 'reviewStatus',
      type: 'string',
      group: ['item', 'review'],
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
      description: 'Only approved items are served. Approving locks the item content.',
      validation: (rule) =>
        rule.required().custom((value, context) => {
          if (value !== 'approved') return true
          const review = (context.document?.review ?? {}) as Record<string, unknown>
          return REVIEW_CHECKS.every((check) => review[check.name] === true)
            ? true
            : 'Complete every review check before approving.'
        }),
    }),
    defineField({
      name: 'sourceStatus',
      type: 'string',
      group: ['item', 'source'],
      options: {
        list: [
          {title: 'Current', value: 'current'},
          {title: 'Stale (source changed)', value: 'stale'},
        ],
        layout: 'radio',
        direction: 'horizontal',
      },
      initialValue: 'current',
      description: 'Set to stale by the generator when a cited transcript chunk changes. Stale items are not served.',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'lesson',
      type: 'reference',
      group: 'item',
      to: [{type: 'lesson'}],
      readOnly: lockedWhenApproved,
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'objective',
      type: 'string',
      group: 'item',
      description: 'What the learner demonstrates, starting with a verb.',
      readOnly: lockedWhenApproved,
      validation: (rule) => rule.required().max(200),
    }),
    defineField({
      name: 'type',
      type: 'string',
      group: 'item',
      options: {
        list: [
          {title: 'Recall', value: 'recall'},
          {title: 'Apply', value: 'apply'},
          {title: 'Transfer', value: 'transfer'},
        ],
        layout: 'radio',
        direction: 'horizontal',
      },
      readOnly: lockedWhenApproved,
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'responseFormat',
      type: 'string',
      group: 'item',
      options: {list: [{title: 'Single choice', value: 'single_choice'}]},
      initialValue: 'single_choice',
      readOnly: true,
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'question',
      type: 'text',
      group: 'item',
      rows: 3,
      readOnly: lockedWhenApproved,
      validation: (rule) => rule.required().max(400),
    }),
    defineField({
      name: 'options',
      type: 'array',
      group: 'item',
      description: 'Each option keeps a stable id (shown under it) even when reordered.',
      readOnly: lockedWhenApproved,
      of: [
        defineArrayMember({
          name: 'assessmentOption',
          title: 'Option',
          type: 'object',
          fields: [defineField({name: 'text', type: 'string', validation: (rule) => rule.required().max(200)})],
          preview: {
            select: {title: 'text', id: '_key'},
            prepare({title, id}) {
              return {title, subtitle: `id: ${id}`}
            },
          },
        }),
      ],
      validation: (rule) =>
        rule
          .required()
          .min(3)
          .max(4)
          .custom((options) => {
            const texts = (options as Array<{text?: string}> | undefined)?.map((option) => normalize(option.text)) ?? []
            return new Set(texts).size === texts.length ? true : 'Options must be distinct.'
          }),
    }),
    defineField({
      name: 'answerKey',
      title: 'Answer key (private)',
      type: 'object',
      group: 'item',
      readOnly: lockedWhenApproved,
      // Required so its field rules run even when the whole object is missing.
      validation: (rule) => rule.required(),
      fields: [
        defineField({
          name: 'correctOptionId',
          title: 'Correct option id',
          type: 'string',
          description: 'The id shown under the correct option.',
          validation: (rule) =>
            rule.required().custom((value, context) => {
              const options = (context.document as AssessmentLike | undefined)?.options ?? []
              return options.some((option) => option._key === value) ? true : 'Must match the id of one option.'
            }),
        }),
        defineField({
          name: 'correctReason',
          title: 'Why the correct option is right',
          type: 'text',
          rows: 2,
          validation: (rule) => rule.required().max(300),
        }),
        defineField({
          name: 'distractorReasons',
          title: 'Why each distractor is wrong',
          type: 'array',
          description: 'One reason per wrong option, tied to its option id (never its position).',
          of: [
            defineArrayMember({
              name: 'distractorReason',
              type: 'object',
              fields: [
                defineField({name: 'optionId', title: 'Option id', type: 'string', validation: (rule) => rule.required()}),
                defineField({name: 'reason', type: 'text', rows: 2, validation: (rule) => rule.required().max(200)}),
              ],
              preview: {select: {title: 'reason', subtitle: 'optionId'}},
            }),
          ],
          validation: (rule) =>
            rule.required().custom((reasons, context) => {
              const document = context.document as AssessmentLike | undefined
              const expected = (document?.options ?? [])
                .map((option) => option._key)
                .filter((id) => id !== document?.answerKey?.correctOptionId)
                .sort()
              const actual = ((reasons as Array<{optionId?: string}> | undefined) ?? []).map((entry) => entry.optionId).sort()
              return JSON.stringify(actual) === JSON.stringify(expected)
                ? true
                : 'Give exactly one reason for each wrong option, by option id.'
            }),
        }),
      ],
    }),
    defineField({
      name: 'hints',
      title: 'Hint ladder (private)',
      type: 'object',
      group: 'item',
      readOnly: lockedWhenApproved,
      validation: (rule) => rule.required(),
      fields: [
        earlyHint('direction', 'Level 1 — direction', 'Where to look or what to consider. Must not reveal the answer.'),
        earlyHint('keyConcept', 'Level 2 — key concept', 'The concept or rule needed. Must not say which option is correct.'),
        defineField({
          name: 'solution',
          title: 'Level 3 — solution',
          type: 'text',
          rows: 3,
          description: 'The full explanation identifying the correct option.',
          validation: (rule) => rule.required().max(800),
        }),
      ],
    }),
    defineField({
      name: 'review',
      type: 'object',
      group: 'review',
      description: 'All checks are required before approval and publishing.',
      fields: [
        ...REVIEW_CHECKS.map((check) =>
          defineField({name: check.name, title: check.title, type: 'boolean', initialValue: false}),
        ),
        defineField({name: 'note', title: 'Reviewer note', type: 'text', rows: 2}),
      ],
    }),
    defineField({
      name: 'sourceExcerpt',
      type: 'text',
      group: 'source',
      rows: 10,
      readOnly: true,
      description: 'The transcript span this item was generated from. Editorial only.',
    }),
    defineField({
      name: 'sourceChunkRefs',
      title: 'Source chunks',
      type: 'array',
      group: 'source',
      readOnly: true,
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
      validation: (rule) => rule.required().min(1),
    }),
    defineField({
      name: 'familyId',
      type: 'string',
      group: 'generation',
      description: 'Stable across versions of the same item.',
      readOnly: lockedWhenApproved,
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'version',
      type: 'number',
      group: 'generation',
      initialValue: 1,
      readOnly: lockedWhenApproved,
      validation: (rule) => rule.required().integer().min(1),
    }),
    defineField({
      name: 'generation',
      type: 'object',
      group: 'generation',
      readOnly: true,
      options: {collapsible: true, collapsed: true},
      fields: [
        defineField({name: 'spanKey', type: 'string'}),
        defineField({name: 'inputHash', type: 'string'}),
        defineField({name: 'spanIndex', type: 'number'}),
        defineField({name: 'ordinal', type: 'number'}),
        defineField({name: 'model', type: 'string'}),
        defineField({name: 'promptVersion', type: 'string'}),
        defineField({name: 'configVersion', type: 'string'}),
        defineField({name: 'generatedAt', type: 'datetime'}),
      ],
    }),
  ],
  preview: {
    select: {
      question: 'question',
      reviewStatus: 'reviewStatus',
      sourceStatus: 'sourceStatus',
      type: 'type',
      version: 'version',
      lesson: 'lesson.title',
    },
    prepare({question, reviewStatus, sourceStatus, type, version, lesson}) {
      const status = sourceStatus === 'stale' ? 'stale' : (reviewStatus ?? 'needs_review').replace('_', ' ')
      return {
        title: question || 'Untitled item',
        subtitle: [status, type, version ? `v${version}` : null, lesson].filter(Boolean).join(' · '),
      }
    },
  },
})
