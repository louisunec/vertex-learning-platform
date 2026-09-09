import {BookmarkIcon} from '@sanity/icons'
import {defineField, defineType} from 'sanity'

export const chapter = defineType({
  name: 'chapter',
  title: 'Chapter',
  type: 'object',
  icon: BookmarkIcon,
  fields: [
    defineField({
      name: 'startSeconds',
      type: 'number',
      validation: (rule) => rule.required().min(0).integer(),
    }),
    defineField({
      name: 'label',
      type: 'string',
      validation: (rule) => rule.required(),
    }),
  ],
  preview: {
    select: {title: 'label', startSeconds: 'startSeconds'},
    prepare({title, startSeconds}) {
      return {title, subtitle: formatSeconds(startSeconds)}
    },
  },
})

export function formatSeconds(value: unknown): string {
  const total = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}
