import {ActivityIcon} from '@sanity/icons'
import {defineArrayMember, defineField, defineType} from 'sanity'

import {formatSeconds} from '../objects/chapter'

/**
 * An editorial learning signal (development plan §5 PR-10): an aggregate
 * over one measurement window that prompts an instructor to look at an
 * assessment version, a lesson moment, or a search topic. A signal is a
 * reason to investigate, never proof that content is wrong.
 *
 * Written only by the signal job (`npm run signals -- aggregate`), with
 * a deterministic id per subject and window. Every computed field is
 * read-only here; the job never overwrites the review fields after it
 * creates the document. `liveEdit`: the review status changes the document
 * directly, through the Review actions. No learner text is stored; search
 * terms appear only when enough people share them, in a collapsed section.
 * Kept out of learner search: the Context MCP allowlists other types only.
 */

export const SIGNAL_REVIEW_STATUSES = [
  {title: 'Open', value: 'open'},
  {title: 'Investigating', value: 'investigating'},
  {title: 'Acknowledged', value: 'acknowledged'},
  {title: 'Resolved', value: 'resolved'},
] as const

export const SIGNAL_TYPE_OPTIONS = [
  {title: 'High first-attempt error rate', value: 'assessment_difficulty'},
  {title: 'Repeated replays', value: 'replay_hotspot'},
  {title: 'Searches with no grounded results', value: 'search_no_results'},
  {title: 'Tutor found insufficient supporting material', value: 'tutor_insufficient_evidence'},
] as const

const computed = {readOnly: true} as const

export const contentSignal = defineType({
  name: 'contentSignal',
  title: 'Content signal',
  type: 'document',
  icon: ActivityIcon,
  liveEdit: true,
  fieldsets: [
    {name: 'measurement', title: 'Measurement', options: {columns: 2}},
    {name: 'review', title: 'Review'},
    {
      name: 'searchTerms',
      title: 'Tokenized search terms',
      description: 'Normalized keywords shared by every person counted here. Hidden by default.',
      options: {collapsible: true, collapsed: true},
    },
    {name: 'provenance', title: 'Provenance', options: {collapsible: true, collapsed: true}},
  ],
  fields: [
    defineField({name: 'title', type: 'string', ...computed}),
    defineField({name: 'signalType', title: 'Signal type', type: 'string', options: {list: [...SIGNAL_TYPE_OPTIONS]}, ...computed}),
    defineField({name: 'summary', type: 'string', ...computed}),
    defineField({
      name: 'reason',
      title: 'Why this was raised',
      type: 'text',
      rows: 3,
      description: 'A prompt to investigate, not a verdict on the content.',
      ...computed,
    }),
    defineField({
      name: 'reviewStatus',
      title: 'Review status',
      type: 'string',
      fieldset: 'review',
      options: {list: [...SIGNAL_REVIEW_STATUSES], layout: 'radio', direction: 'horizontal'},
      initialValue: 'open',
      description: 'Change it with the Review actions (Start investigating, Acknowledge, Resolve, Reopen) in the document menu.',
      readOnly: true,
    }),
    defineField({name: 'reviewNote', title: 'Review note', type: 'text', rows: 3, fieldset: 'review'}),
    defineField({name: 'reviewedAt', title: 'Status changed at', type: 'datetime', fieldset: 'review', readOnly: true}),
    defineField({name: 'reviewedBy', title: 'Status changed by (user id)', type: 'string', fieldset: 'review', readOnly: true}),
    defineField({
      name: 'lesson',
      type: 'reference',
      to: [{type: 'lesson'}],
      weak: true,
      ...computed,
    }),
    defineField({
      name: 'assessment',
      title: 'Assessment version',
      type: 'reference',
      to: [{type: 'assessment'}],
      weak: true,
      ...computed,
    }),
    defineField({name: 'assessmentFamilyId', title: 'Assessment family', type: 'string', ...computed}),
    defineField({name: 'assessmentVersion', title: 'Version', type: 'number', ...computed}),
    defineField({
      name: 'timestampSeconds',
      title: 'Timestamp (seconds)',
      type: 'number',
      description: 'Start of the lesson moment, where applicable.',
      ...computed,
    }),
    defineField({name: 'timestampEndSeconds', title: 'Timestamp end (seconds)', type: 'number', ...computed}),
    defineField({
      name: 'window',
      title: 'Measurement window',
      type: 'object',
      ...computed,
      fields: [
        defineField({name: 'start', type: 'datetime'}),
        defineField({name: 'end', title: 'End (exclusive)', type: 'datetime'}),
        defineField({name: 'days', type: 'number'}),
        defineField({name: 'key', type: 'string'}),
        defineField({name: 'partial', title: 'Window still in progress', type: 'boolean'}),
      ],
    }),
    defineField({
      name: 'measurement',
      type: 'object',
      ...computed,
      fields: [
        defineField({name: 'numerator', type: 'number'}),
        defineField({name: 'numeratorLabel', title: 'Counts', type: 'string'}),
        defineField({name: 'denominator', type: 'number'}),
        defineField({name: 'denominatorLabel', title: 'Out of (denominator)', type: 'string'}),
        defineField({name: 'rate', title: 'Rate (0–1)', type: 'number'}),
        defineField({name: 'distinctLearners', title: 'Distinct people', type: 'number'}),
      ],
    }),
    defineField({
      name: 'supporting',
      title: 'Supporting counts',
      type: 'array',
      ...computed,
      of: [
        defineArrayMember({
          type: 'object',
          name: 'metric',
          fields: [
            defineField({name: 'key', type: 'string'}),
            defineField({name: 'label', type: 'string'}),
            defineField({name: 'value', type: 'number'}),
          ],
          preview: {
            select: {label: 'label', value: 'value'},
            prepare: ({label, value}) => ({title: `${value ?? 0} · ${label ?? ''}`}),
          },
        }),
      ],
    }),
    defineField({
      name: 'searchTerms',
      title: 'Terms',
      type: 'array',
      of: [{type: 'string'}],
      fieldset: 'searchTerms',
      ...computed,
    }),
    defineField({
      name: 'rule',
      title: 'Rule',
      type: 'object',
      ...computed,
      fields: [
        defineField({name: 'text', type: 'text', rows: 2}),
        defineField({name: 'version', type: 'string'}),
      ],
    }),
    defineField({name: 'thresholdMet', title: 'Meets its threshold on the latest computation', type: 'boolean', ...computed}),
    defineField({
      name: 'regeneration',
      title: 'Draft regeneration',
      type: 'object',
      description: 'Queued draft candidates only. Nothing is published without review.',
      ...computed,
      fields: [
        defineField({name: 'status', type: 'string'}),
        defineField({name: 'candidateId', type: 'string'}),
        defineField({name: 'queuedDay', type: 'string'}),
        defineField({name: 'draftIds', title: 'Draft ids', type: 'array', of: [{type: 'string'}]}),
        defineField({name: 'detail', type: 'string'}),
      ],
    }),
    defineField({
      name: 'source',
      type: 'string',
      fieldset: 'provenance',
      options: {
        list: [
          {title: 'Learner database (attempts, tutor)', value: 'postgres'},
          {title: 'Product analytics (PostHog)', value: 'posthog'},
          {title: 'Fixture (not real learner activity)', value: 'fixture'},
        ],
      },
      ...computed,
    }),
    defineField({name: 'fixture', title: 'Fixture data', type: 'boolean', fieldset: 'provenance', ...computed}),
    defineField({name: 'subjectKey', title: 'Subject key', type: 'string', fieldset: 'provenance', ...computed}),
    defineField({name: 'computedAt', title: 'Computed at', type: 'datetime', fieldset: 'provenance', ...computed}),
  ],
  orderings: [
    {title: 'Newest window', name: 'windowDesc', by: [{field: 'window.start', direction: 'desc'}]},
    {title: 'Most people', name: 'peopleDesc', by: [{field: 'measurement.distinctLearners', direction: 'desc'}]},
  ],
  preview: {
    select: {
      title: 'title',
      summary: 'summary',
      status: 'reviewStatus',
      windowKey: 'window.key',
      lesson: 'lesson.title',
      assessmentLesson: 'assessment.lesson.title',
      timestamp: 'timestampSeconds',
      met: 'thresholdMet',
    },
    prepare({title, summary, status, windowKey, lesson, assessmentLesson, timestamp, met}) {
      const where = [lesson ?? assessmentLesson, typeof timestamp === 'number' ? formatSeconds(timestamp) : null].filter(Boolean).join(' @ ')
      return {
        title: `${title ?? 'Signal'}${where ? ` · ${where}` : ''}`,
        subtitle: [String(status ?? 'open'), met === false ? 'below threshold now' : null, summary, windowKey].filter(Boolean).join(' · '),
      }
    },
  },
})
