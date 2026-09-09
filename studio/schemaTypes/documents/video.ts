import {VideoIcon} from '@sanity/icons'
import {defineArrayMember, defineField, defineType} from 'sanity'

/**
 * Internal search/playback support record — never a learner-facing result.
 * One document per unique normalized video URL, written by the offline
 * ingestion tool with the deterministic id `video-<provider>-<id>`.
 */
export const video = defineType({
  name: 'video',
  title: 'Video',
  type: 'document',
  icon: VideoIcon,
  description: 'Internal search index for a lesson video. Created and updated by the ingestion tool.',
  fields: [
    defineField({
      name: 'videoId',
      type: 'string',
      title: 'Stable id',
      description: 'Derived from the normalized source URL by the ingestion tool, e.g. "youtube-dQw4w9WgXcQ".',
      readOnly: true,
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'provider',
      type: 'string',
      options: {
        list: [
          {title: 'YouTube', value: 'youtube'},
          {title: 'Vimeo', value: 'vimeo'},
          {title: 'Bunny', value: 'bunny'},
        ],
      },
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'providerVideoId',
      type: 'string',
      description: 'The provider-native id (YouTube id, Vimeo numeric id, Bunny library/guid).',
      readOnly: true,
    }),
    defineField({
      name: 'sourceUrl',
      type: 'url',
      description: 'Normalized canonical URL for this video.',
      validation: (rule) => rule.required().uri({scheme: ['http', 'https']}),
    }),
    defineField({
      name: 'title',
      type: 'string',
      description: 'Provider title, for reference only.',
    }),
    defineField({
      name: 'durationSeconds',
      type: 'number',
      validation: (rule) => rule.min(0).integer(),
    }),
    defineField({
      name: 'chapters',
      type: 'array',
      description: 'Timestamped chapter labels. Preferred source for video-moment search.',
      of: [defineArrayMember({type: 'chapter'})],
    }),
    defineField({
      name: 'transcriptChunks',
      type: 'array',
      description: 'Short timestamped caption chunks. Never loaded whole in the request path.',
      of: [defineArrayMember({type: 'transcriptChunk'})],
    }),
    defineField({
      name: 'ingestedAt',
      type: 'datetime',
      readOnly: true,
    }),
  ],
  preview: {
    select: {title: 'title', videoId: 'videoId', chapters: 'chapters', chunks: 'transcriptChunks'},
    prepare({title, videoId, chapters, chunks}) {
      const c = Array.isArray(chapters) ? chapters.length : 0
      const t = Array.isArray(chunks) ? chunks.length : 0
      return {
        title: title || videoId,
        subtitle: `${videoId ?? ''} · ${c} chapters · ${t} chunks`,
      }
    },
  },
})
