import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {
  MAX_CHUNK_CHARS,
  MAX_CHUNK_SECONDS,
  buildVideoDocument,
  chunkCaptionEvents,
  parseDescriptionChapters,
  parseJson3Captions,
} from './ingest.ts'
import {parseVideoUrl} from './provider.ts'

describe('parseJson3Captions', () => {
  it('joins segments, collapses whitespace, and orders by start', () => {
    const events = parseJson3Captions({
      events: [
        {tStartMs: 5000, segs: [{utf8: 'second'}, {utf8: ' event'}]},
        {tStartMs: 0, segs: [{utf8: "Let's"}, {utf8: ' dive\n'}, {utf8: ' in', tOffsetMs: 400}]},
      ],
    })
    assert.deepEqual(events, [
      {startMs: 0, text: "Let's dive in"},
      {startMs: 5000, text: 'second event'},
    ])
  })

  it('skips append/windowing events without spoken text', () => {
    const events = parseJson3Captions({
      events: [
        {tStartMs: 0, segs: [{utf8: 'hello'}]},
        {tStartMs: 100, aAppend: 1, segs: [{utf8: '\n'}]},
        {tStartMs: 200, segs: [{utf8: '  \n '}]},
        {tStartMs: 300},
      ],
    })
    assert.deepEqual(events, [{startMs: 0, text: 'hello'}])
  })

  it('returns [] for malformed payloads', () => {
    assert.deepEqual(parseJson3Captions(null), [])
    assert.deepEqual(parseJson3Captions('nope'), [])
    assert.deepEqual(parseJson3Captions({events: 'nope'}), [])
  })
})

describe('chunkCaptionEvents', () => {
  it('merges consecutive events into one chunk starting at the first event', () => {
    const chunks = chunkCaptionEvents([
      {startMs: 1500, text: 'one'},
      {startMs: 4000, text: 'two'},
    ])
    assert.deepEqual(chunks, [{startSeconds: 1, text: 'one two'}])
  })

  it('closes a chunk at the duration limit', () => {
    const chunks = chunkCaptionEvents([
      {startMs: 0, text: 'a'},
      {startMs: MAX_CHUNK_SECONDS * 1000, text: 'b'},
    ])
    assert.deepEqual(chunks, [
      {startSeconds: 0, text: 'a'},
      {startSeconds: MAX_CHUNK_SECONDS, text: 'b'},
    ])
  })

  it('closes a chunk at the character limit', () => {
    const long = 'x'.repeat(MAX_CHUNK_CHARS - 10)
    const chunks = chunkCaptionEvents([
      {startMs: 0, text: long},
      {startMs: 2000, text: 'overflowing'},
    ])
    assert.deepEqual(chunks, [
      {startSeconds: 0, text: long},
      {startSeconds: 2, text: 'overflowing'},
    ])
  })

  it('returns [] for no events', () => {
    assert.deepEqual(chunkCaptionEvents([]), [])
  })
})

describe('parseDescriptionChapters', () => {
  const description = [
    'Great video about routing.',
    '00:00 Introduction to Routing',
    '00:16 - Setting Up',
    '1:26 Creating Your First Route',
    '(03:02) Additional Routes',
    'Subscribe for more!',
  ].join('\n')

  it('parses leading-timestamp lines into chapters', () => {
    assert.deepEqual(parseDescriptionChapters(description, 350), [
      {startSeconds: 0, label: 'Introduction to Routing'},
      {startSeconds: 16, label: 'Setting Up'},
      {startSeconds: 86, label: 'Creating Your First Route'},
      {startSeconds: 182, label: 'Additional Routes'},
    ])
  })

  it('supports H:MM:SS timestamps', () => {
    const chapters = parseDescriptionChapters('0:00 Intro\n1:02:03 Deep dive')
    assert.deepEqual(chapters, [
      {startSeconds: 0, label: 'Intro'},
      {startSeconds: 3723, label: 'Deep dive'},
    ])
  })

  it('rejects lists that break YouTube chapter rules', () => {
    // fewer than two chapters
    assert.deepEqual(parseDescriptionChapters('00:00 Only one'), [])
    // first chapter not at zero
    assert.deepEqual(parseDescriptionChapters('00:10 Late\n00:20 Later'), [])
    // not strictly ascending
    assert.deepEqual(parseDescriptionChapters('00:00 A\n00:30 B\n00:20 C'), [])
    // timestamp beyond the video duration
    assert.deepEqual(parseDescriptionChapters('00:00 A\n09:00 B', 350), [])
    assert.deepEqual(parseDescriptionChapters(null), [])
  })
})

describe('buildVideoDocument', () => {
  const parsed = parseVideoUrl('https://youtu.be/dQw4w9WgXcQ')!
  const ingestedAt = new Date('2026-09-09T12:00:00.000Z')

  it('builds a validated document with deterministic id and keys', () => {
    const doc = buildVideoDocument({
      parsed,
      title: 'A video',
      durationSeconds: 350.9,
      chapters: [{startSeconds: 0, label: 'Intro'}],
      transcriptChunks: [{startSeconds: 3, text: 'hello there'}],
      ingestedAt,
    })
    assert.deepEqual(doc, {
      _id: 'video-youtube-dQw4w9WgXcQ',
      _type: 'video',
      videoId: 'youtube-dQw4w9WgXcQ',
      provider: 'youtube',
      providerVideoId: 'dQw4w9WgXcQ',
      sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      title: 'A video',
      durationSeconds: 350,
      chapters: [{_key: 'ch-0-0', startSeconds: 0, label: 'Intro'}],
      transcriptChunks: [{_key: 'tc-3-0', startSeconds: 3, text: 'hello there'}],
      ingestedAt: '2026-09-09T12:00:00.000Z',
    })
  })

  it('omits empty optional fields instead of writing empty values', () => {
    const doc = buildVideoDocument({
      parsed,
      title: '  ',
      durationSeconds: null,
      chapters: [{startSeconds: 0, label: 'Intro'}, {startSeconds: 10, label: 'More'}],
      transcriptChunks: [],
      ingestedAt,
    })
    assert.equal(doc.title, undefined)
    assert.equal(doc.durationSeconds, undefined)
    assert.equal(doc.transcriptChunks, undefined)
    assert.equal(doc.chapters?.length, 2)
  })

  it('refuses a document with neither chapters nor transcript chunks', () => {
    assert.throws(
      () => buildVideoDocument({parsed, chapters: [], transcriptChunks: [], ingestedAt}),
      /no chapters and no transcript chunks/,
    )
  })
})
