import {DocumentTextIcon} from '@sanity/icons'
import {defineField, defineType} from 'sanity'

/**
 * One processed unit of the assessment generator (`npm run
 * generate:assessments`): a transcript section, or a lesson's transfer call
 * over one chosen section. Written in the same transaction as the unit's
 * drafts. Its id derives from the unit's generation key (section identity +
 * prompt, model, and config versions), so reruns skip the unit — even when
 * it produced no candidates — unless `--force` is passed.
 * Operational log only: never an assessment, never served to learners,
 * read-only in the Studio.
 */
export const assessmentGenerationRecord = defineType({
  name: 'assessmentGenerationRecord',
  title: 'Assessment generation record',
  type: 'document',
  icon: DocumentTextIcon,
  readOnly: true,
  fields: [
    defineField({
      name: 'kind',
      type: 'string',
      options: {
        list: [
          {title: 'Section (recall/apply)', value: 'section'},
          {title: 'Lesson transfer', value: 'lesson_transfer'},
        ],
      },
    }),
    defineField({name: 'lesson', type: 'reference', to: [{type: 'lesson'}]}),
    defineField({name: 'spanIndex', title: 'Section', type: 'number'}),
    defineField({
      name: 'outcome',
      type: 'string',
      options: {
        list: [
          {title: 'Drafted', value: 'drafted'},
          {title: 'No candidates', value: 'no_candidates'},
          {title: 'All candidates rejected', value: 'all_rejected'},
        ],
      },
    }),
    defineField({name: 'draftIds', title: 'Draft ids', type: 'array', of: [{type: 'string'}]}),
    defineField({name: 'rejectionReasons', type: 'array', of: [{type: 'string'}]}),
    defineField({name: 'modelSkipReason', type: 'string'}),
    defineField({name: 'spanKey', type: 'string'}),
    defineField({name: 'promptVersion', type: 'string'}),
    defineField({name: 'model', type: 'string'}),
    defineField({name: 'configVersion', type: 'string'}),
    defineField({name: 'processedAt', type: 'datetime'}),
  ],
  preview: {
    select: {kind: 'kind', outcome: 'outcome', spanIndex: 'spanIndex', lesson: 'lesson.title', processedAt: 'processedAt'},
    prepare({kind, outcome, spanIndex, lesson, processedAt}) {
      const unit = kind === 'lesson_transfer' ? `transfer (section ${spanIndex ?? '?'})` : `section ${spanIndex ?? '?'}`
      return {
        title: `${lesson ?? 'Lesson'} · ${unit}`,
        subtitle: [String(outcome ?? '').replace('_', ' '), processedAt?.slice(0, 10)].filter(Boolean).join(' · '),
      }
    },
  },
})
