import {ImagesIcon} from '@sanity/icons'
import {defineArrayMember, defineField, defineType} from 'sanity'

/**
 * On-screen text for one video (development plan §5 PR-2), written only by
 * the offline indexer (`npm run index:visuals`) with the deterministic id
 * `visual-<video document id>`. OCR chunks are text read from sampled frames;
 * VLM chunks are labelled model interpretations, never ground truth. All of
 * it is untrusted data.
 *
 * Internal index: read-only in the Studio and absent from the create menu.
 * Search reads bounded matching chunks behind the `search-visual-evidence`
 * flag, through the search Context scope; it is never a result on its own.
 */
export const videoVisualIndex = defineType({
  name: 'videoVisualIndex',
  title: 'Video visual index',
  type: 'document',
  icon: ImagesIcon,
  readOnly: true,
  description: 'On-screen text extracted from owned or licensed media. Created and updated by the visual indexer.',
  fields: [
    defineField({name: 'video', type: 'reference', to: [{type: 'video'}], validation: (rule) => rule.required()}),
    defineField({
      name: 'extractionVersion',
      type: 'string',
      description: 'Sampler, OCR, merge, gate, and VLM prompt version. Part of every chunk revision.',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'sourceRevision',
      type: 'string',
      description: 'Content hash of the media file that was indexed.',
      validation: (rule) => rule.required(),
    }),
    defineField({name: 'durationSeconds', type: 'number', validation: (rule) => rule.min(0).integer()}),
    defineField({name: 'indexedAt', type: 'datetime'}),
    defineField({
      name: 'chunks',
      type: 'array',
      description: 'Timestamped on-screen text. Never loaded whole in the request path.',
      of: [
        defineArrayMember({
          name: 'visualChunk',
          type: 'object',
          fields: [
            defineField({
              name: 'source',
              type: 'string',
              options: {
                list: [
                  {title: 'OCR', value: 'ocr'},
                  {title: 'VLM interpretation', value: 'vlm'},
                ],
              },
              validation: (rule) => rule.required(),
            }),
            defineField({name: 'startSeconds', type: 'number', validation: (rule) => rule.required().min(0).integer()}),
            defineField({name: 'endSeconds', type: 'number', validation: (rule) => rule.required().min(0).integer()}),
            defineField({name: 'text', type: 'text', validation: (rule) => rule.required()}),
            defineField({
              name: 'vlmLabel',
              type: 'string',
              description: 'What the VLM took the frame to show (VLM chunks only).',
            }),
            defineField({
              name: 'frameRef',
              type: 'object',
              fields: [
                defineField({name: 'timestampSeconds', type: 'number'}),
                defineField({name: 'frameHash', type: 'string'}),
              ],
            }),
            defineField({
              name: 'quality',
              type: 'object',
              fields: [
                defineField({name: 'ocrConfidence', type: 'number', description: 'Mean OCR word confidence, 0–100.'}),
                defineField({name: 'textDensity', type: 'number', description: 'Share of the frame covered by read text, 0–1.'}),
              ],
            }),
          ],
          preview: {
            select: {source: 'source', start: 'startSeconds', end: 'endSeconds', text: 'text', label: 'vlmLabel'},
            prepare({source, start, end, text, label}) {
              return {
                title: String(text ?? '').split('\n')[0],
                subtitle: [`${source === 'vlm' ? `VLM (${label ?? '?'})` : 'OCR'}`, `${start ?? '?'}–${end ?? '?'}s`].join(' · '),
              }
            },
          },
        }),
      ],
    }),
    defineField({
      name: 'coverage',
      type: 'object',
      fields: [
        defineField({name: 'framesSampled', type: 'number'}),
        defineField({name: 'framesOcrd', title: "Frames OCR'd", type: 'number'}),
        defineField({name: 'vlmCalls', title: 'VLM calls', type: 'number'}),
        defineField({
          name: 'skippedSpans',
          type: 'array',
          description: 'Spans a cap or error cut short. Any entry marks the index partial.',
          of: [
            defineArrayMember({
              name: 'skippedSpan',
              type: 'object',
              fields: [
                defineField({name: 'startSeconds', type: 'number'}),
                defineField({name: 'endSeconds', type: 'number'}),
                defineField({
                  name: 'reason',
                  type: 'string',
                  options: {
                    list: ['frame_cap', 'ocr_cap', 'vlm_cap', 'spend_cap', 'wall_time', 'ocr_error', 'vlm_error'],
                  },
                }),
              ],
              preview: {
                select: {reason: 'reason', start: 'startSeconds', end: 'endSeconds'},
                prepare: ({reason, start, end}) => ({title: String(reason ?? ''), subtitle: `${start ?? '?'}–${end ?? '?'}s`}),
              },
            }),
          ],
        }),
        defineField({name: 'partial', type: 'boolean'}),
        defineField({name: 'estimatedCostUsd', title: 'Estimated cost (USD)', type: 'number'}),
        defineField({name: 'durationMs', title: 'Processing time (ms)', type: 'number'}),
      ],
    }),
  ],
  preview: {
    select: {title: 'video.title', videoId: 'video.videoId', chunks: 'chunks', partial: 'coverage.partial'},
    prepare({title, videoId, chunks, partial}) {
      const count = Array.isArray(chunks) ? chunks.length : 0
      return {
        title: title || videoId || 'Video',
        subtitle: [`${count} visual chunks`, partial ? 'partial' : null].filter(Boolean).join(' · '),
      }
    },
  },
})
