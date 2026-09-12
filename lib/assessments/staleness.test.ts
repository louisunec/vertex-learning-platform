import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {toSourceChunks} from '../evidence/chunks.ts'
import type {ExistingVersion} from './generate.ts'
import {findNewlyStale, isStale, resolveCitations} from './staleness.ts'

const VIDEO_DOC = 'video-youtube-dQw4w9WgXcQ'
const video = (secondText = 'useState returns a pair') => ({
  _id: VIDEO_DOC,
  durationSeconds: 90,
  transcriptChunks: [
    {_key: 'tc-0-0', startSeconds: 0, text: 'intro'},
    {_key: 'tc-30-1', startSeconds: 30, text: secondText},
  ],
})

const current = toSourceChunks(video())
const refOf = (i: number) => ({chunkId: current[i].chunkId, chunkRevision: current[i].chunkRevision})

describe('isStale', () => {
  it('is current while every ref matches the stored chunk revision', () => {
    assert.equal(isStale([refOf(0), refOf(1)], current), false)
  })

  it('is stale when a chunk text changes, a chunk disappears, or there are no refs', () => {
    assert.equal(isStale([refOf(1)], toSourceChunks(video('useState returns a tuple'))), true)
    assert.equal(isStale([{chunkId: `${VIDEO_DOC}:gone`, chunkRevision: 'x'}], current), true)
    assert.equal(isStale([], current), true)
  })
})

describe('findNewlyStale', () => {
  it('returns changed versions not already marked stale, draft and published alike', () => {
    const existing: ExistingVersion[] = [
      {_id: 'assessment-a-v1', familyId: 'a', version: 1, sourceChunkRefs: [refOf(1)]},
      {_id: 'drafts.assessment-a-v1', familyId: 'a', version: 1, sourceChunkRefs: [refOf(1)]},
      {_id: 'assessment-b-v1', familyId: 'b', version: 1, sourceChunkRefs: [refOf(0)]},
      {_id: 'assessment-c-v1', familyId: 'c', version: 1, sourceStatus: 'stale', sourceChunkRefs: [refOf(1)]},
    ]
    assert.deepEqual(findNewlyStale(existing, toSourceChunks(video('edited'))), [
      'assessment-a-v1',
      'drafts.assessment-a-v1',
    ])
  })
})

describe('resolveCitations', () => {
  const lesson = {lessonId: 'lesson-hooks', lessonSlug: 'react-hooks'}

  it('builds lesson deep links from current chunk records', () => {
    const result = resolveCitations([refOf(1)], lesson, current)
    assert.deepEqual(result, {
      status: 'resolved',
      citations: [
        {
          chunkId: `${VIDEO_DOC}:tc-30-1`,
          lessonId: 'lesson-hooks',
          sourceRevision: current[1].chunkRevision,
          startSeconds: 30,
          endSeconds: 60,
          label: '0:30–1:00',
          href: '/lessons/react-hooks?t=30',
        },
      ],
    })
  })

  it('reports stale instead of citing a changed chunk', () => {
    const result = resolveCitations([refOf(0), refOf(1)], lesson, toSourceChunks(video('edited')))
    assert.deepEqual(result, {status: 'stale', missing: [`${VIDEO_DOC}:tc-30-1`]})
  })
})
