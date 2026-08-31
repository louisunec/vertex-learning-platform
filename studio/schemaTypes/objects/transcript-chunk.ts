import {CommentIcon} from '@sanity/icons'
import {defineField, defineType} from 'sanity'

import {formatSeconds} from './chapter'

export const transcriptChunk = defineType({
  name: 'transcriptChunk',
  title: 'Transcript chunk',
  type: 'object',
  icon: CommentIcon,
  fields: [
    defineField({
      name: 'startSeconds',
      type: 'number',
      validation: (rule) => rule.required().min(0).integer(),
    }),
    defineField({
      name: 'text',
      type: 'text',
      rows: 2,
      validation: (rule) => rule.required(),
    }),
  ],
  preview: {
    select: {title: 'text', startSeconds: 'startSeconds'},
    prepare({title, startSeconds}) {
      return {title, subtitle: formatSeconds(startSeconds)}
    },
  },
})
