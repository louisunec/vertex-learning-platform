import {UserIcon} from '@sanity/icons'
import {defineArrayMember, defineField, defineType} from 'sanity'

export const instructor = defineType({
  name: 'instructor',
  title: 'Instructor',
  type: 'document',
  icon: UserIcon,
  fields: [
    defineField({
      name: 'name',
      type: 'string',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'slug',
      type: 'slug',
      options: {source: 'name', maxLength: 96},
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'photo',
      type: 'image',
      options: {hotspot: true},
      fields: [defineField({name: 'alt', type: 'string', title: 'Alternative text'})],
    }),
    defineField({
      name: 'expertise',
      type: 'array',
      description: 'Areas of expertise, e.g. "Next.js", "Docker".',
      of: [defineArrayMember({type: 'string'})],
    }),
    defineField({
      name: 'bio',
      type: 'text',
      rows: 4,
    }),
  ],
  preview: {
    select: {title: 'name', media: 'photo', expertise: 'expertise'},
    prepare({title, media, expertise}) {
      return {
        title,
        media,
        subtitle: Array.isArray(expertise) ? expertise.join(', ') : undefined,
      }
    },
  },
})
