import {ArrowRightIcon} from '@sanity/icons'
import {defineArrayMember, defineField, defineType, type ConditionalPropertyCallback} from 'sanity'

/**
 * One proposed or reviewed prerequisite relationship between two concepts
 * (development plan §5 PR-3). Drafted by `npm run generate:concepts --
 * prerequisites` among published, approved concepts, with status "proposed",
 * and published only after review. One document per ordered pair: its id
 * derives from the two concept ids; a reconsideration after a rejection adds a
 * suffix, leaving the rejected edge untouched. Speaking order and topic
 * similarity are not prerequisites.
 */

export const PREREQUISITE_REVIEW_CHECKS = [
  {
    name: 'genuineDependency',
    title: 'Learning the dependent needs the prerequisite (not just earlier in the course, not just a related topic)',
  },
  {name: 'directionCorrect', title: 'The direction is right: the prerequisite comes first'},
  {name: 'evidenceSupports', title: 'The rationale and cited chunks support the dependency'},
] as const

const locked: ConditionalPropertyCallback = ({document}) => document?.status === 'approved' || document?.status === 'retired'

export const conceptPrerequisite = defineType({
  name: 'conceptPrerequisite',
  title: 'Concept prerequisite',
  type: 'document',
  icon: ArrowRightIcon,
  description: 'Prerequisite edge, created only by `npm run generate:concepts -- prerequisites`.',
  groups: [
    {name: 'edge', title: 'Edge', default: true},
    {name: 'review', title: 'Review'},
    {name: 'generation', title: 'Generation'},
  ],
  fields: [
    defineField({
      name: 'status',
      type: 'string',
      group: ['edge', 'review'],
      options: {
        list: [
          {title: 'Proposed', value: 'proposed'},
          {title: 'Approved', value: 'approved'},
          {title: 'Rejected', value: 'rejected'},
          {title: 'Retired', value: 'retired'},
        ],
        layout: 'radio',
        direction: 'horizontal',
      },
      initialValue: 'proposed',
      description:
        'Only approved, published edges are part of the graph. A rejected edge is kept; it is proposed again only when its concepts or generation versions change.',
      validation: (rule) =>
        rule.required().custom((value, context) => {
          if (value !== 'approved') return true
          const review = (context.document?.review ?? {}) as Record<string, unknown>
          return PREREQUISITE_REVIEW_CHECKS.every((check) => review[check.name] === true)
            ? true
            : 'Complete every review check before approving.'
        }),
    }),
    defineField({
      name: 'sourceStatus',
      type: 'string',
      group: 'edge',
      options: {
        list: [
          {title: 'Current', value: 'current'},
          {title: 'Stale (source changed)', value: 'stale'},
        ],
        layout: 'radio',
        direction: 'horizontal',
      },
      initialValue: 'current',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'prerequisite',
      type: 'reference',
      group: 'edge',
      to: [{type: 'concept'}],
      readOnly: true,
      description: 'Learned first.',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'dependent',
      type: 'reference',
      group: 'edge',
      to: [{type: 'concept'}],
      readOnly: true,
      description: 'Needs the prerequisite.',
      validation: (rule) =>
        rule.required().custom((value, context) => {
          const prerequisite = (context.document?.prerequisite as {_ref?: string} | undefined)?._ref
          return value?._ref && value._ref === prerequisite ? 'A concept cannot be its own prerequisite.' : true
        }),
    }),
    defineField({
      name: 'rationale',
      type: 'text',
      group: 'edge',
      rows: 3,
      readOnly: locked,
      validation: (rule) => rule.required().max(300),
    }),
    defineField({
      name: 'evidence',
      title: 'Evidence chunks',
      type: 'array',
      group: 'edge',
      readOnly: true,
      of: [defineArrayMember({type: 'conceptSourceRef'})],
    }),
    defineField({
      name: 'review',
      type: 'object',
      group: 'review',
      description: 'All checks are required before approval and publishing.',
      fields: [
        ...PREREQUISITE_REVIEW_CHECKS.map((check) =>
          defineField({name: check.name, title: check.title, type: 'boolean', initialValue: false}),
        ),
        defineField({name: 'note', title: 'Reviewer note', type: 'text', rows: 2}),
      ],
    }),
    defineField({
      name: 'generation',
      type: 'object',
      group: 'generation',
      readOnly: true,
      options: {collapsible: true, collapsed: true},
      fields: [
        defineField({name: 'course', type: 'reference', to: [{type: 'course'}]}),
        defineField({name: 'key', type: 'string'}),
        defineField({name: 'model', type: 'string'}),
        defineField({name: 'promptVersion', type: 'string'}),
        defineField({name: 'configVersion', type: 'string'}),
        defineField({name: 'suppressionKey', type: 'string'}),
        defineField({name: 'reconsiders', type: 'array', of: [defineArrayMember({type: 'string'})]}),
        defineField({name: 'contentHash', type: 'string'}),
        defineField({name: 'generatedAt', type: 'datetime'}),
      ],
    }),
  ],
  preview: {
    select: {prerequisite: 'prerequisite.name', dependent: 'dependent.name', status: 'status', sourceStatus: 'sourceStatus'},
    prepare({prerequisite, dependent, status, sourceStatus}) {
      return {
        title: `${prerequisite ?? '?'} → ${dependent ?? '?'}`,
        subtitle: sourceStatus === 'stale' ? 'stale' : status,
      }
    },
  },
})
