import {BulbOutlineIcon} from '@sanity/icons'
import {defineArrayMember, defineField, defineType, type ConditionalPropertyCallback} from 'sanity'

/**
 * One reviewed skill concept (development plan §5 PR-3). Drafted by `npm run
 * generate:concepts -- extract` as `drafts.concept-<conceptId>` and published
 * only after editorial review. `conceptId` is assigned once and never changes,
 * even when the concept is renamed. Content only: learner mastery lives
 * outside Sanity (PR-4).
 *
 * A retired concept stays published as a tombstone (`merged`, `split`, or
 * `archived`) so assessments and evidence that cite its id keep their
 * history; `lib/concepts/resolve.ts` follows `mergedInto` to the successor.
 */

export const CONCEPT_REVIEW_CHECKS = [
  {name: 'nameAccurate', title: 'The name is the conventional term for this idea'},
  {name: 'summarySupported', title: 'The summary is correct and supported by the source excerpt'},
  {name: 'objectivesAssessable', title: 'Each objective is assessable and belongs to this concept'},
  {name: 'notDuplicate', title: 'No other concept covers the same idea (matching is lexical: check synonyms)'},
  {name: 'granularityAppropriate', title: 'One assessable skill: neither a whole topic nor one step of an example'},
] as const

/** Fields covered by `revision`: a published change needs `revision + 1` (see `actions/concept-publish.ts`). */
export const CONCEPT_CONTENT_FIELDS = ['name', 'aliases', 'summary', 'objectives', 'sourceRefs', 'lessons'] as const

export const CONCEPT_TOMBSTONE_STATUSES = ['merged', 'split', 'archived'] as const

type ConceptLike = {
  _id?: string
  reviewStatus?: string
  review?: Record<string, unknown>
  mergedInto?: {_ref?: string}
  splitInto?: Array<{_ref?: string}>
}

const locked: ConditionalPropertyCallback = ({document}) =>
  document?.reviewStatus === 'approved' || (CONCEPT_TOMBSTONE_STATUSES as readonly unknown[]).includes(document?.reviewStatus)

const publishedId = (id: string | undefined) => (id ?? '').replace(/^drafts\./, '')

/** Reference picker limited to other approved concepts. */
const approvedOtherConcept = ({document}: {document: {_id?: string}}) => ({
  filter: 'reviewStatus == "approved" && _id != $self',
  params: {self: publishedId(document._id)},
})

export const concept = defineType({
  name: 'concept',
  title: 'Concept',
  type: 'document',
  icon: BulbOutlineIcon,
  description: 'Reviewed skill concept, created only by `npm run generate:concepts -- extract`.',
  groups: [
    {name: 'concept', title: 'Concept', default: true},
    {name: 'review', title: 'Review'},
    {name: 'source', title: 'Source'},
    {name: 'generation', title: 'Generation'},
  ],
  fields: [
    defineField({
      name: 'reviewStatus',
      type: 'string',
      group: ['concept', 'review'],
      options: {
        list: [
          {title: 'Needs review', value: 'needs_review'},
          {title: 'Approved', value: 'approved'},
          {title: 'Rejected', value: 'rejected'},
          {title: 'Merged', value: 'merged'},
          {title: 'Split', value: 'split'},
          {title: 'Archived', value: 'archived'},
        ],
        layout: 'radio',
        direction: 'horizontal',
      },
      initialValue: 'needs_review',
      description:
        'Approving locks the content. Merged, split, and archived concepts stay published as tombstones so old references still resolve.',
      validation: (rule) =>
        rule.required().custom((value, context) => {
          const document = context.document as ConceptLike | undefined
          if (value === 'approved') {
            const review = document?.review ?? {}
            return CONCEPT_REVIEW_CHECKS.every((check) => review[check.name] === true)
              ? true
              : 'Complete every review check before approving.'
          }
          if (value === 'merged' && !document?.mergedInto?._ref) return 'Choose the concept this one was merged into.'
          if (value === 'split' && (document?.splitInto?.length ?? 0) < 2) return 'Choose at least two concepts this one was split into.'
          return true
        }),
    }),
    defineField({
      name: 'sourceStatus',
      type: 'string',
      group: ['concept', 'source'],
      options: {
        list: [
          {title: 'Current', value: 'current'},
          {title: 'Stale (source changed)', value: 'stale'},
        ],
        layout: 'radio',
        direction: 'horizontal',
      },
      initialValue: 'current',
      description: 'Set to stale by the generator when a cited transcript chunk changes.',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'mergedInto',
      title: 'Merged into',
      type: 'reference',
      group: 'concept',
      to: [{type: 'concept'}],
      options: {filter: approvedOtherConcept, disableNew: true},
      hidden: ({document}) => document?.reviewStatus !== 'merged',
      description: 'The approved concept that replaces this one. Move useful aliases to it before merging.',
      validation: (rule) =>
        rule.custom((value, context) =>
          value?._ref && value._ref === publishedId(context.document?._id) ? 'A concept cannot be merged into itself.' : true,
        ),
    }),
    defineField({
      name: 'splitInto',
      title: 'Split into',
      type: 'array',
      group: 'concept',
      of: [defineArrayMember({type: 'reference', to: [{type: 'concept'}], options: {filter: approvedOtherConcept, disableNew: true}})],
      hidden: ({document}) => document?.reviewStatus !== 'split',
      description: 'The approved concepts that replace this one. Learner evidence is not copied to them automatically.',
      validation: (rule) =>
        rule.unique().custom((value, context) =>
          (value as Array<{_ref?: string}> | undefined)?.some((entry) => entry._ref === publishedId(context.document?._id))
            ? 'A concept cannot be split into itself.'
            : true,
        ),
    }),
    defineField({
      name: 'conceptId',
      title: 'Concept id',
      type: 'string',
      group: 'concept',
      readOnly: true,
      description: 'Stable id, assigned once. Evidence and mastery refer to it; renaming never changes it.',
      validation: (rule) =>
        rule
          .required()
          .regex(/^cpt-[a-z0-9]+(?:-[a-z0-9]+)*$/)
          .max(48),
    }),
    defineField({
      name: 'name',
      type: 'string',
      group: 'concept',
      readOnly: locked,
      validation: (rule) => rule.required().max(80),
    }),
    defineField({
      name: 'aliases',
      type: 'array',
      group: 'concept',
      of: [defineArrayMember({type: 'string', validation: (rule) => rule.max(80)})],
      readOnly: locked,
      description: 'Other established names or abbreviations for exactly this concept.',
      validation: (rule) => rule.unique().max(8),
    }),
    defineField({
      name: 'summary',
      type: 'text',
      group: 'concept',
      rows: 3,
      readOnly: locked,
      validation: (rule) => rule.required().max(300),
    }),
    defineField({
      name: 'objectives',
      type: 'array',
      group: 'concept',
      readOnly: locked,
      description: 'Assessable learning objectives, each starting with a verb. Each keeps a stable id.',
      of: [
        defineArrayMember({
          name: 'conceptObjective',
          title: 'Objective',
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
      validation: (rule) => rule.required().min(1).max(4),
    }),
    defineField({
      name: 'revision',
      type: 'number',
      group: 'concept',
      initialValue: 1,
      readOnly: locked,
      description: 'Starts at 1. To change a published concept, set it back to Needs review, edit, and increase this by one.',
      validation: (rule) => rule.required().integer().min(1),
    }),
    defineField({
      name: 'review',
      type: 'object',
      group: 'review',
      description: 'All checks are required before approval and publishing.',
      fields: [
        ...CONCEPT_REVIEW_CHECKS.map((check) => defineField({name: check.name, title: check.title, type: 'boolean', initialValue: false})),
        defineField({name: 'note', title: 'Reviewer note', type: 'text', rows: 2}),
      ],
    }),
    defineField({
      name: 'lessons',
      type: 'array',
      group: 'source',
      readOnly: true,
      description: 'Lessons that teach this concept, derived from the source chunks.',
      of: [defineArrayMember({type: 'reference', to: [{type: 'lesson'}]})],
    }),
    defineField({
      name: 'sourceRefs',
      title: 'Source chunks',
      type: 'array',
      group: 'source',
      readOnly: true,
      of: [defineArrayMember({type: 'conceptSourceRef'})],
      validation: (rule) => rule.required().min(1),
    }),
    defineField({
      name: 'sourceExcerpt',
      type: 'text',
      group: 'source',
      rows: 10,
      readOnly: true,
      description: 'The cited transcript chunks. Editorial only.',
    }),
    defineField({
      name: 'generation',
      type: 'object',
      group: 'generation',
      readOnly: true,
      options: {collapsible: true, collapsed: true},
      fields: [
        defineField({name: 'course', type: 'reference', to: [{type: 'course'}]}),
        defineField({name: 'model', type: 'string'}),
        defineField({name: 'promptVersion', type: 'string'}),
        defineField({name: 'configVersion', type: 'string'}),
        defineField({name: 'extractionKeys', type: 'array', of: [defineArrayMember({type: 'string'})]}),
        defineField({name: 'candidateIds', title: 'Candidate ids', type: 'array', of: [defineArrayMember({type: 'string'})]}),
        defineField({name: 'role', type: 'string', description: 'primary when any candidate was a span\'s primary concept.'}),
        defineField({name: 'suppressionKey', type: 'string'}),
        defineField({name: 'reconsiders', type: 'string', description: 'The rejected concept id this one reconsiders.'}),
        defineField({name: 'appliedMerges', title: 'Applied merge proposals', type: 'array', of: [defineArrayMember({type: 'string'})]}),
        defineField({name: 'contentHash', type: 'string'}),
        defineField({name: 'generatedAt', type: 'datetime'}),
      ],
    }),
  ],
  preview: {
    select: {name: 'name', conceptId: 'conceptId', reviewStatus: 'reviewStatus', sourceStatus: 'sourceStatus', revision: 'revision'},
    prepare({name, conceptId, reviewStatus, sourceStatus, revision}) {
      const status = sourceStatus === 'stale' ? 'stale' : String(reviewStatus ?? 'needs_review').replace('_', ' ')
      return {title: name || 'Untitled concept', subtitle: [status, conceptId, revision ? `r${revision}` : null].filter(Boolean).join(' · ')}
    },
  },
})
