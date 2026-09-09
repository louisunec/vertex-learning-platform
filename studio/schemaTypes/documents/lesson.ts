import {PlayIcon} from '@sanity/icons'
import {defineArrayMember, defineField, defineType} from 'sanity'

/**
 * A lesson does not store its parent course. Course/module context is derived
 * from the course that references it (see the web data layer).
 */
export const lesson = defineType({
  name: 'lesson',
  title: 'Lesson',
  type: 'document',
  icon: PlayIcon,
  groups: [
    {name: 'content', title: 'Content', default: true},
    {name: 'video', title: 'Video'},
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
      name: 'videoUrl',
      type: 'url',
      group: 'video',
      description: 'YouTube, Vimeo or Bunny video URL. Playback and search moments resolve through this URL.',
      validation: (rule) => rule.uri({scheme: ['http', 'https']}),
    }),
    defineField({
      name: 'poster',
      type: 'image',
      group: 'video',
      description: 'Thumbnail shown in cards and search results.',
      options: {hotspot: true},
      fields: [defineField({name: 'alt', type: 'string', title: 'Alternative text'})],
    }),
    defineField({
      name: 'durationSeconds',
      type: 'number',
      group: 'video',
      title: 'Duration (seconds)',
      validation: (rule) => rule.min(0).integer(),
    }),
    defineField({
      name: 'notes',
      type: 'blockContent',
      group: 'content',
      description: 'Lesson notes (Portable Text).',
    }),
    defineField({
      name: 'keyPoints',
      type: 'array',
      group: 'content',
      of: [defineArrayMember({type: 'string'})],
    }),
    defineField({
      name: 'proTip',
      type: 'text',
      group: 'content',
      rows: 3,
    }),
    defineField({
      name: 'resources',
      type: 'array',
      group: 'content',
      of: [defineArrayMember({type: 'resource'})],
    }),
    defineField({
      name: 'freePreview',
      type: 'boolean',
      group: 'display',
      description: 'Display label only; it does not control access.',
      initialValue: false,
    }),
    defineField({
      name: 'studentCountDisplay',
      type: 'string',
      group: 'display',
      title: 'Student count (display)',
    }),
  ],
  preview: {
    select: {title: 'title', media: 'poster', durationSeconds: 'durationSeconds'},
    prepare({title, media, durationSeconds}) {
      const minutes = typeof durationSeconds === 'number' ? `${Math.round(durationSeconds / 60)} min` : undefined
      return {title, media, subtitle: minutes}
    },
  },
})
