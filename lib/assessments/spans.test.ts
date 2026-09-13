import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import type {SourceChunk} from '../evidence/chunks.ts'
import {buildSpans, MAX_SPAN_CHUNKS} from './spans.ts'

/** `count` chunks, one every 20 s starting at `from`. */
function chunks(count: number, from = 0): SourceChunk[] {
  return Array.from({length: count}, (_, i) => {
    const start = from + i * 20
    return {
      chunkId: `v:tc-${start}`,
      chunkRevision: `r${start}`,
      source: 'transcript' as const,
      startSeconds: start,
      endSeconds: start + 20,
      text: `t${start}`,
    }
  })
}

const sizes = (spans: ReturnType<typeof buildSpans>) => spans.map((span) => span.chunks.length)

describe('buildSpans', () => {
  it('returns no spans without chunks', () => {
    assert.deepEqual(buildSpans([]), [])
  })

  it('windows chunks without chapters and merges a small tail into the previous span', () => {
    assert.deepEqual(sizes(buildSpans(chunks(31))), [10, 10, 11])
    assert.deepEqual(sizes(buildSpans(chunks(25))), [10, 10, 5])
  })

  it('never exceeds the per-span cap', () => {
    for (const count of [1, 12, 13, 29, 130]) {
      const spans = buildSpans(chunks(count))
      assert.ok(spans.every((span) => span.chunks.length <= MAX_SPAN_CHUNKS), `count ${count}`)
      assert.equal(spans.reduce((sum, span) => sum + span.chunks.length, 0), count)
    }
  })

  it('follows chapter boundaries and labels spans with their chapter', () => {
    // 0–100 s: 5 chunks, 100–200 s: 5 chunks.
    const spans = buildSpans(chunks(10), [
      {startSeconds: 0, label: 'Intro'},
      {startSeconds: 100, label: 'useState'},
    ])
    assert.deepEqual(sizes(spans), [5, 5])
    assert.deepEqual(
      spans.map((span) => [span.index, span.chapterLabel, span.startSeconds, span.endSeconds]),
      [
        [0, 'Intro', 0, 100],
        [1, 'useState', 100, 200],
      ],
    )
  })

  it('splits a long chapter into near-equal pieces within the cap', () => {
    const spans = buildSpans(chunks(13), [{startSeconds: 0, label: 'Everything'}])
    assert.deepEqual(sizes(spans), [7, 6])
  })

  it('keeps a tiny chapter as its own span, so every span carries its own chapter label', () => {
    const spans = buildSpans(chunks(7), [
      {startSeconds: 0, label: 'Main'},
      {startSeconds: 100, label: 'Outro'},
    ])
    // 5 chunks + 2-chunk outro → two spans; merging would send the outro labelled "Main".
    assert.deepEqual(sizes(spans), [5, 2])
    assert.deepEqual(
      spans.map((span) => span.chapterLabel),
      ['Main', 'Outro'],
    )
  })

  it('ignores invalid chapters and is deterministic', () => {
    const input = chunks(22)
    const chapters = [
      {startSeconds: -5, label: 'bad'},
      {startSeconds: 0, label: '  '},
    ]
    assert.deepEqual(buildSpans(input, chapters), buildSpans(input))
    assert.deepEqual(buildSpans(input), buildSpans(input))
  })
})
