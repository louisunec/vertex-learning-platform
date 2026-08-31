import {CheckmarkCircleIcon} from '@sanity/icons'
import {defineField, defineType} from 'sanity'

/**
 * Per-learner state: one document per (Clerk user, lesson), id
 * `progress-<clerkUserId>-<lessonId>`. Written only by the authenticated
 * server route; the browser never writes it directly.
 */
export const progress = defineType({
  name: 'progress',
  title: 'Learner progress',
  type: 'document',
  icon: CheckmarkCircleIcon,
  fields: [
    defineField({
      name: 'userId',
      type: 'string',
      title: 'Clerk user id',
      readOnly: true,
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'lesson',
      type: 'reference',
      to: [{type: 'lesson'}],
      readOnly: true,
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'completed',
      type: 'boolean',
      initialValue: false,
    }),
    defineField({
      name: 'completedAt',
      type: 'datetime',
    }),
    defineField({
      name: 'resumeSeconds',
      type: 'number',
      description: 'Last known playback position in the lesson video.',
      validation: (rule) => rule.min(0).integer(),
    }),
    defineField({
      name: 'updatedAt',
      type: 'datetime',
    }),
  ],
  preview: {
    select: {userId: 'userId', lesson: 'lesson.title', completed: 'completed', resumeSeconds: 'resumeSeconds'},
    prepare({userId, lesson, completed, resumeSeconds}) {
      return {
        title: lesson || 'Lesson',
        subtitle: `${userId ?? ''} · ${completed ? 'completed' : `at ${resumeSeconds ?? 0}s`}`,
      }
    },
  },
})
