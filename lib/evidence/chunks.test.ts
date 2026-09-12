import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {chunkIdFor, chunkRevisionOf, hashParts, toSourceChunks} from './chunks.ts'

const VIDEO_ID = 'video-youtube-dQw4w9WgXcQ'

describe('chunk identity', () => {
  it('ids a chunk by video document and chunk key', () => {
    assert.equal(chunkIdFor(VIDEO_ID, 'tc-42-3'), 'video-youtube-dQw4w9WgXcQ:tc-42-3')
  })

  it('keeps the revision for identical content and changes it when text or start changes', () => {
    const base = chunkRevisionOf({startSeconds: 42, text: 'useState returns a pair'})
    assert.equal(base, chunkRevisionOf({startSeconds: 42, text: 'useState returns a pair'}))
    assert.notEqual(base, chunkRevisionOf({startSeconds: 42, text: 'useState returns a tuple'}))
    assert.notEqual(base, chunkRevisionOf({startSeconds: 43, text: 'useState returns a pair'}))
    assert.match(base, /^[0-9a-f]{16}$/)
  })

  it('separates hash parts unambiguously', () => {
    assert.notEqual(hashParts(['ab', 'c']), hashParts(['a', 'bc']))
  })
})

describe('toSourceChunks', () => {
  it('orders chunks and ends each where the next begins', () => {
    const chunks = toSourceChunks({
      _id: VIDEO_ID,
      durationSeconds: 100,
      transcriptChunks: [
        {_key: 'tc-30-1', startSeconds: 30, text: 'second'},
        {_key: 'tc-0-0', startSeconds: 0, text: 'first'},
      ],
    })
    assert.deepEqual(
      chunks.map((c) => [c.chunkId, c.startSeconds, c.endSeconds]),
      [
        [`${VIDEO_ID}:tc-0-0`, 0, 30],
        [`${VIDEO_ID}:tc-30-1`, 30, 60],
      ],
    )
  })

  it('caps the last chunk at the video duration', () => {
    const [chunk] = toSourceChunks({
      _id: VIDEO_ID,
      durationSeconds: 95,
      transcriptChunks: [{_key: 'tc-90-0', startSeconds: 90, text: 'outro'}],
    })
    assert.equal(chunk.endSeconds, 95)
  })

  it('falls back to MAX_CHUNK_SECONDS without a duration and never ends before it starts', () => {
    const [noDuration] = toSourceChunks({_id: VIDEO_ID, transcriptChunks: [{_key: 'a', startSeconds: 10, text: 'x'}]})
    assert.equal(noDuration.endSeconds, 40)
    const [pastDuration] = toSourceChunks({
      _id: VIDEO_ID,
      durationSeconds: 5,
      transcriptChunks: [{_key: 'a', startSeconds: 10, text: 'x'}],
    })
    assert.equal(pastDuration.endSeconds, 10)
  })

  it('drops chunks with invalid keys, timestamps, or empty text', () => {
    const chunks = toSourceChunks({
      _id: VIDEO_ID,
      transcriptChunks: [
        {_key: 'ok', startSeconds: 1, text: 'kept'},
        {_key: '', startSeconds: 2, text: 'no key'},
        {_key: 'neg', startSeconds: -1, text: 'negative'},
        {_key: 'frac', startSeconds: 1.5, text: 'fractional'},
        {_key: 'blank', startSeconds: 3, text: '   '},
      ],
    })
    assert.deepEqual(
      chunks.map((c) => c.text),
      ['kept'],
    )
  })
})
