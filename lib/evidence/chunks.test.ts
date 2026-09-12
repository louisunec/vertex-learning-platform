import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {
  chunkIdFor,
  chunkRevisionOf,
  hashParts,
  toSourceChunks,
  toVisualSourceChunks,
  visualChunkRevisionOf,
  visualIndexIdFor,
} from './chunks.ts'

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

describe('visual chunk identity', () => {
  const INDEX_ID = visualIndexIdFor(VIDEO_ID)
  const chunk = {source: 'ocr' as const, startSeconds: 5, endSeconds: 10, text: 'if (x <= 10) {'}

  it('ids the index by video document and chunks by index and key', () => {
    assert.equal(INDEX_ID, 'visual-video-youtube-dQw4w9WgXcQ')
    const [source] = toVisualSourceChunks({_id: INDEX_ID, extractionVersion: 'v1', chunks: [{_key: 'ocr-5-a', ...chunk}]})
    assert.equal(source.chunkId, 'visual-video-youtube-dQw4w9WgXcQ:ocr-5-a')
    assert.equal(source.source, 'ocr')
  })

  it('changes the revision with source, times, text, or extraction version', () => {
    const base = visualChunkRevisionOf(chunk, 'v1')
    assert.equal(base, visualChunkRevisionOf({...chunk}, 'v1'))
    assert.match(base, /^[0-9a-f]{16}$/)
    for (const changed of [
      visualChunkRevisionOf({...chunk, source: 'vlm'}, 'v1'),
      visualChunkRevisionOf({...chunk, startSeconds: 6}, 'v1'),
      visualChunkRevisionOf({...chunk, endSeconds: 11}, 'v1'),
      visualChunkRevisionOf({...chunk, text: 'if (x < 10) {'}, 'v1'),
      visualChunkRevisionOf(chunk, 'v2'),
    ]) {
      assert.notEqual(changed, base)
    }
  })

  it('keeps transcript revisions unchanged and labels transcript chunks', () => {
    const [transcript] = toSourceChunks({_id: VIDEO_ID, transcriptChunks: [{_key: 'a', startSeconds: 42, text: 'useState returns a pair'}]})
    assert.equal(transcript.chunkRevision, chunkRevisionOf({startSeconds: 42, text: 'useState returns a pair'}))
    assert.equal(transcript.source, 'transcript')
  })

  it('orders valid chunks and drops invalid ones', () => {
    const chunks = toVisualSourceChunks({
      _id: INDEX_ID,
      extractionVersion: 'v1',
      chunks: [
        {_key: 'b', source: 'vlm', startSeconds: 8, endSeconds: 12, text: 'diagram of the render cycle'},
        {_key: 'a', ...chunk},
        {_key: 'no-source', startSeconds: 1, endSeconds: 2, text: 'x'},
        {_key: 'transcript', source: 'transcript' as never, startSeconds: 1, endSeconds: 2, text: 'x'},
        {_key: 'reversed', source: 'ocr', startSeconds: 9, endSeconds: 3, text: 'x'},
        {_key: 'frac', source: 'ocr', startSeconds: 1.5, endSeconds: 3, text: 'x'},
        {_key: 'blank', source: 'ocr', startSeconds: 1, endSeconds: 3, text: '  '},
      ],
    })
    assert.deepEqual(
      chunks.map((c) => c.chunkId.split(':')[1]),
      ['a', 'b'],
    )
  })

  it('has no citable chunks without an extraction version', () => {
    assert.deepEqual(toVisualSourceChunks({_id: INDEX_ID, chunks: [{_key: 'a', ...chunk}]}), [])
  })
})
