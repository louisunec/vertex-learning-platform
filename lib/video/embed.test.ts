import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {getEmbedSource, toStartSeconds} from './embed.ts'
import {parseVideoUrl} from './provider.ts'

function parsed(url: string) {
  const result = parseVideoUrl(url)
  assert.ok(result, `expected ${url} to parse`)
  return result
}

describe('toStartSeconds', () => {
  it('accepts non-negative numbers and numeric strings, flooring to whole seconds', () => {
    assert.equal(toStartSeconds(90), 90)
    assert.equal(toStartSeconds(90.9), 90)
    assert.equal(toStartSeconds('90'), 90)
    assert.equal(toStartSeconds(0), 0)
  })

  it('rejects negative, non-numeric and missing values', () => {
    assert.equal(toStartSeconds(-1), null)
    assert.equal(toStartSeconds('abc'), null)
    assert.equal(toStartSeconds(''), null)
    assert.equal(toStartSeconds(undefined), null)
    assert.equal(toStartSeconds(null), null)
    assert.equal(toStartSeconds(Infinity), null)
  })
})

describe('getEmbedSource', () => {
  const youtube = parsed('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
  const vimeo = parsed('https://vimeo.com/76979871')
  const bunny = parsed('https://iframe.mediadelivery.net/embed/123/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')

  it('builds a YouTube privacy-enhanced embed with a start second', () => {
    assert.equal(
      getEmbedSource(youtube),
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0&enablejsapi=1',
    )
    assert.equal(
      getEmbedSource(youtube, 90),
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0&enablejsapi=1&start=90',
    )
  })

  it('builds a Vimeo player URL with a #t fragment', () => {
    assert.equal(getEmbedSource(vimeo), 'https://player.vimeo.com/video/76979871')
    assert.equal(getEmbedSource(vimeo, 90), 'https://player.vimeo.com/video/76979871#t=90s')
  })

  it('builds a Bunny embed URL with a t query param', () => {
    assert.equal(
      getEmbedSource(bunny),
      'https://iframe.mediadelivery.net/embed/123/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    )
    assert.equal(
      getEmbedSource(bunny, 90),
      'https://iframe.mediadelivery.net/embed/123/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee?t=90',
    )
  })

  it('ignores invalid start values', () => {
    assert.equal(
      getEmbedSource(youtube, -5),
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0&enablejsapi=1',
    )
  })
})
