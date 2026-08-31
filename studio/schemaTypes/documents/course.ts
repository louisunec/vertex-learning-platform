import {BookIcon} from '@sanity/icons'
import {defineArrayMember, defineField, defineType} from 'sanity'

export const course = defineType({
  name: 'course',
  title: 'Course',
  type: 'document',
  icon: BookIcon,
  groups: [
    {name: 'content', title: 'Content', default: true},
    {name: 'curriculum', title: 'Curriculum'},
    {name: 'display', title: 'Display'},
  ],
  fields: [
    defineField({
      name: 'title',
      type: 'string',
      group: 'content',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'slug',
      type: 'slug',
      group: 'content',
      options: {source: 'title', maxLength: 96},
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'summary',
      type: 'text',
      group: 'content',
      rows: 3,
      description: 'Short marketing description shown in the catalog and course header.',
    }),
    defineField({
      name: 'coverImage',
      type: 'image',
      group: 'content',
      options: {hotspot: true},
      fields: [defineField({name: 'alt', type: 'string', title: 'Alternative text'})],
    }),
    defineField({
      name: 'level',
      type: 'string',
      group: 'content',
      options: {
        list: [
          {title: 'Beginner', value: 'beginner'},
          {title: 'Intermediate', value: 'intermediate'},
          {title: 'Advanced', value: 'advanced'},
        ],
        layout: 'radio',
      },
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'instructor',
      type: 'reference',
      group: 'content',
      to: [{type: 'instructor'}],
    }),
    defineField({
      name: 'category',
      type: 'reference',
      group: 'content',
      to: [{type: 'category'}],
    }),
    defineField({
      name: 'learningOutcomes',
      type: 'array',
      group: 'content',
      description: 'Short ordered list of what learners will be able to do.',
      of: [defineArrayMember({type: 'learningOutcome'})],
    }),
    defineField({
      name: 'modules',
      type: 'array',
      group: 'curriculum',
      description: 'Ordered modules. Module numbers follow this order and are not stored.',
      of: [defineArrayMember({type: 'module'})],
    }),
    defineField({
      name: 'priceDisplay',
      type: 'string',
      group: 'display',
      title: 'Price (display)',
      description: 'Display-only label, e.g. "$49" or "Free". Not used for access control.',
    }),
    defineField({
      name: 'popular',
      type: 'boolean',
      group: 'display',
      description: 'Show a "Popular" badge in the catalog.',
      initialValue: false,
    }),
    defineField({
      name: 'studentCountDisplay',
      type: 'string',
      group: 'display',
      title: 'Student count (display)',
      description: 'Display-only label, e.g. "12,400 students".',
    }),
  ],
  preview: {
    select: {title: 'title', level: 'level', media: 'coverImage', instructor: 'instructor.name'},
    prepare({title, level, media, instructor}) {
      return {
        title,
        subtitle: [level, instructor].filter(Boolean).join(' · '),
        media,
      }
    },
  },
})
