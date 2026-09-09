import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {parseVideoUrl, toSafeIdSegment} from './provider.ts'

describe('parseVideoUrl — YouTube', () => {
  const variants = [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PL123',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ?si=abc',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=10',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube.com/live/dQw4w9WgXcQ',
    'youtu.be/dQw4w9WgXcQ',
    '  https://youtu.be/dQw4w9WgXcQ  ',
  ]

  it('collapses every URL variant to one stable identity', () => {
    const ids = new Set(variants.map((v) => parseVideoUrl(v)?.documentId))
    assert.deepEqual([...ids], ['video-youtube-dQw4w9WgXcQ'])
  })

  it('returns provider metadata and a canonical URL', () => {
    assert.deepEqual(parseVideoUrl('https://youtu.be/dQw4w9WgXcQ'), {
      provider: 'youtube',
      providerVideoId: 'dQw4w9WgXcQ',
      videoId: 'youtube-dQw4w9WgXcQ',
      documentId: 'video-youtube-dQw4w9WgXcQ',
      canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    })
  })

  it('keeps distinct videos distinct', () => {
    const a = parseVideoUrl('https://youtu.be/dQw4w9WgXcQ')?.documentId
    const b = parseVideoUrl('https://youtu.be/9bZkp7q19f0')?.documentId
    assert.notEqual(a, b)
  })

  it('rejects malformed ids and non-video YouTube pages', () => {
    assert.equal(parseVideoUrl('https://www.youtube.com/watch?v=short'), null)
    assert.equal(parseVideoUrl('https://www.youtube.com/channel/UC123'), null)
    assert.equal(parseVideoUrl('https://www.youtube.com/'), null)
  })
})

describe('parseVideoUrl — Vimeo', () => {
  it('collapses page, player, channel, group and unlisted-hash URLs', () => {
    const variants = [
      'https://vimeo.com/123456789',
      'https://vimeo.com/123456789/abcdef1234',
      'https://player.vimeo.com/video/123456789?h=abcdef1234',
      'https://vimeo.com/channels/staffpicks/123456789',
      'https://vimeo.com/groups/motion/videos/123456789',
    ]
    const ids = new Set(variants.map((v) => parseVideoUrl(v)?.documentId))
    assert.deepEqual([...ids], ['video-vimeo-123456789'])
    assert.equal(parseVideoUrl('https://vimeo.com/123456789')?.canonicalUrl, 'https://vimeo.com/123456789')
  })

  it('rejects non-numeric ids', () => {
    assert.equal(parseVideoUrl('https://vimeo.com/user/settings'), null)
    assert.equal(parseVideoUrl('https://player.vimeo.com/api'), null)
  })
})

describe('parseVideoUrl — Bunny', () => {
  const guid = '0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D'

  it('collapses embed/play URLs and normalizes the guid case', () => {
    const variants = [
      `https://iframe.mediadelivery.net/embed/12345/${guid}?autoplay=true`,
      `https://iframe.mediadelivery.net/play/12345/${guid.toLowerCase()}`,
      `https://video.bunnycdn.com/play/12345/${guid}`,
    ]
    const parsed = variants.map((v) => parseVideoUrl(v))
    const ids = new Set(parsed.map((p) => p?.documentId))
    assert.deepEqual([...ids], [`video-bunny-12345-${guid.toLowerCase()}`])
    assert.equal(parsed[0]?.providerVideoId, `12345/${guid.toLowerCase()}`)
    assert.equal(parsed[0]?.canonicalUrl, `https://iframe.mediadelivery.net/embed/12345/${guid.toLowerCase()}`)
  })

  it('keeps the same guid in different libraries distinct', () => {
    const a = parseVideoUrl(`https://iframe.mediadelivery.net/embed/1/${guid}`)?.documentId
    const b = parseVideoUrl(`https://iframe.mediadelivery.net/embed/2/${guid}`)?.documentId
    assert.notEqual(a, b)
  })

  it('rejects malformed library ids or guids', () => {
    assert.equal(parseVideoUrl('https://iframe.mediadelivery.net/embed/abc/not-a-guid'), null)
    assert.equal(parseVideoUrl(`https://iframe.mediadelivery.net/${guid}`), null)
  })
})

describe('parseVideoUrl — unsupported input', () => {
  it('returns null for empty, malformed, non-http and unknown-host input', () => {
    for (const input of [null, undefined, '', '   ', 'not a url', 'ftp://youtu.be/dQw4w9WgXcQ', 'https://example.com/watch?v=dQw4w9WgXcQ', 'https://vz-123.b-cdn.net/abc/playlist.m3u8']) {
      assert.equal(parseVideoUrl(input), null, `expected null for ${String(input)}`)
    }
  })
})

describe('toSafeIdSegment', () => {
  it('replaces characters Sanity rejects in document ids', () => {
    assert.equal(toSafeIdSegment('12345/0a1b.c?d e'), '12345-0a1b-c-d-e')
    assert.equal(toSafeIdSegment('-_ok_-'), '-_ok_-')
  })
})
