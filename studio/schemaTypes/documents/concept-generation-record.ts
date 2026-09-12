import {DocumentTextIcon} from '@sanity/icons'
import {defineArrayMember, defineField, defineType} from 'sanity'

/**
 * One processed unit of the concept generator (`npm run generate:concepts`):
 * a transcript span's extraction, holding its validated candidates, or a
 * course's prerequisite proposal. Its id derives from the unit's generation
 * key (inputs plus prompt, model, and config versions), so reruns skip it
 * unless `--force`. Concept drafts are a deterministic projection of the
 * extraction records. Operational log only: never served, read-only here.
 */
export const conceptGenerationRecord = defineType({
  name: 'conceptGenerationRecord',
  title: 'Concept generation record',
  type: 'document',
  icon: DocumentTextIcon,
  readOnly: true,
  fields: [
    defineField({
      name: 'kind',
      type: 'string',
      options: {
        list: [
          {title: 'Span extraction', value: 'span_extraction'},
          {title: 'Course prerequisites', value: 'course_prerequisites'},
          {title: 'Course consolidation', value: 'course_consolidation'},
        ],
      },
    }),
    defineField({name: 'lesson', type: 'reference', to: [{type: 'lesson'}]}),
    defineField({name: 'course', type: 'reference', to: [{type: 'course'}]}),
    defineField({name: 'spanIndex', title: 'Section', type: 'number'}),
    defineField({
      name: 'outcome',
      type: 'string',
      options: {
        list: [
          {title: 'Extracted', value: 'extracted'},
          {title: 'Proposed', value: 'proposed'},
          {title: 'No candidates', value: 'no_candidates'},
          {title: 'All candidates rejected', value: 'all_rejected'},
        ],
      },
    }),
    defineField({
      name: 'candidates',
      type: 'array',
      of: [
        defineArrayMember({
          name: 'conceptCandidate',
          type: 'object',
          fields: [
            defineField({name: 'role', type: 'string', options: {list: ['primary', 'secondary']}}),
            defineField({name: 'fingerprint', type: 'string'}),
            defineField({name: 'name', type: 'string'}),
            defineField({name: 'aliases', type: 'array', of: [defineArrayMember({type: 'string'})]}),
            defineField({name: 'summary', type: 'text', rows: 2}),
            defineField({name: 'objectives', type: 'array', of: [defineArrayMember({type: 'string'})]}),
            defineField({name: 'independenceReason', type: 'text', rows: 2}),
            defineField({name: 'sourceRefs', type: 'array', of: [defineArrayMember({type: 'conceptSourceRef'})]}),
          ],
          preview: {select: {title: 'name', subtitle: 'role'}},
        }),
      ],
    }),
    defineField({
      name: 'rejectedCandidates',
      description: 'Kept for audit. Suppresses only the same candidate at the same source, prompt, and config versions.',
      type: 'array',
      of: [
        defineArrayMember({
          name: 'rejectedConceptCandidate',
          type: 'object',
          fields: [
            defineField({name: 'candidateId', type: 'string'}),
            defineField({name: 'role', type: 'string'}),
            defineField({name: 'name', type: 'string'}),
            defineField({name: 'reason', type: 'string'}),
            defineField({name: 'fingerprint', type: 'string'}),
          ],
          preview: {select: {title: 'name', subtitle: 'reason'}},
        }),
      ],
    }),
    defineField({
      name: 'excludedDetails',
      description: 'Facts, examples, or details the model left out as not concepts.',
      type: 'array',
      of: [defineArrayMember({type: 'string'})],
    }),
    defineField({name: 'droppedAliases', title: 'Aliases dropped by the alias rule', type: 'number'}),
    defineField({name: 'draftIds', title: 'Draft ids', type: 'array', of: [defineArrayMember({type: 'string'})]}),
    defineField({name: 'rejectionReasons', type: 'array', of: [defineArrayMember({type: 'string'})]}),
    defineField({name: 'modelSkipReason', type: 'string'}),
    defineField({name: 'key', type: 'string'}),
    defineField({name: 'promptVersion', type: 'string'}),
    defineField({name: 'model', type: 'string'}),
    defineField({name: 'configVersion', type: 'string'}),
    defineField({name: 'processedAt', type: 'datetime'}),
  ],
  preview: {
    select: {kind: 'kind', outcome: 'outcome', spanIndex: 'spanIndex', lesson: 'lesson.title', course: 'course.title', processedAt: 'processedAt'},
    prepare({kind, outcome, spanIndex, lesson, course, processedAt}) {
      const title =
        kind === 'course_prerequisites' || kind === 'course_consolidation'
          ? `${course ?? 'Course'} · ${kind === 'course_prerequisites' ? 'prerequisites' : 'consolidation'}`
          : `${lesson ?? 'Lesson'} · section ${spanIndex ?? '?'}`
      return {title, subtitle: [String(outcome ?? '').replace('_', ' '), processedAt?.slice(0, 10)].filter(Boolean).join(' · ')}
    },
  },
})
