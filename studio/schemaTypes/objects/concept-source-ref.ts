import {defineField, defineType} from 'sanity'

import {formatSeconds} from './chapter'

/**
 * One transcript chunk cited by a concept, a prerequisite edge, or a
 * generation candidate (development plan §5 PR-3). Ids, revisions, and times
 * are copied from stored video records by the generator — never typed by
 * hand, never authored by the model. Same identity as PR-1 `sourceChunkRef`
 * (`lib/evidence/chunks.ts`), plus the lesson the chunk was cited from.
 */
export const conceptSourceRef = defineType({
  name: 'conceptSourceRef',
  title: 'Source chunk',
  type: 'object',
  readOnly: true,
  fields: [
    defineField({name: 'chunkId', type: 'string'}),
    defineField({name: 'chunkRevision', type: 'string'}),
    defineField({name: 'startSeconds', type: 'number'}),
    defineField({name: 'endSeconds', type: 'number'}),
    defineField({name: 'lesson', type: 'reference', to: [{type: 'lesson'}]}),
  ],
  preview: {
    select: {chunkId: 'chunkId', start: 'startSeconds', end: 'endSeconds', lesson: 'lesson.title'},
    prepare({chunkId, start, end, lesson}) {
      return {title: `${lesson ?? 'Lesson'} · ${formatSeconds(start)}–${formatSeconds(end)}`, subtitle: chunkId}
    },
  },
})
