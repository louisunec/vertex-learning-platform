import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {
  buildCourseCandidatesQuery,
  buildLessonCandidatesQuery,
  buildVideoCandidatesQuery,
  buildVisualCandidatesQuery,
  LESSON_VIDEO_INDEX_QUERY,
  MAX_MOMENTS_PER_VIDEO,
  MAX_VISUAL_CANDIDATES,
  MAX_VISUAL_LINES,
} from './queries.ts'

/**
 * Every document filter keeps its OR chain in parentheses and filters `_type`
 * explicitly. GROQ binds `&&` tighter than `||`, so an unparenthesized chain
 * would not compose safely with conditions combined around it. This is one
 * layer of defence alongside the Context scope and row validation in
 * `retrieve.ts`; none of them is relied on alone.
 */

/** Filters of every `*[…]` document query in `query`. */
function documentFilters(query: string): string[] {
  const filters: string[] = []
  for (let start = query.indexOf('*['); start >= 0; start = query.indexOf('*[', start + 2)) {
    let depth = 0
    let inString = false
    for (let i = start + 1; i < query.length; i++) {
      const char = query[i]
      if (inString) {
        if (char === '\\') i++
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') inString = true
      else if ('([{'.includes(char)) depth++
      else if (')]}'.includes(char) && --depth === 0) {
        filters.push(query.slice(start + 2, i))
        break
      }
    }
  }
  return filters
}

/** Whether `filter` has an `||` outside any brackets or string literals. */
function hasTopLevelOr(filter: string): boolean {
  let depth = 0
  let inString = false
  for (let i = 0; i < filter.length; i++) {
    const char = filter[i]
    if (inString) {
      if (char === '\\') i++
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if ('([{'.includes(char)) depth++
    else if (')]}'.includes(char)) depth--
    else if (depth === 0 && filter.startsWith('||', i)) return true
  }
  return false
}

const TERMS = ['hooks', 'use-state']
const QUERIES = {
  lesson: buildLessonCandidatesQuery(TERMS),
  video: buildVideoCandidatesQuery(TERMS),
  course: buildCourseCandidatesQuery(TERMS),
  visual: buildVisualCandidatesQuery(TERMS),
  lessonVideoIndex: LESSON_VIDEO_INDEX_QUERY,
}

describe('query composition safety', () => {
  it('detects an unparenthesized top-level OR', () => {
    assert.deepEqual(documentFilters('*[_type == "a" || _type == "b"]'), ['_type == "a" || _type == "b"'])
    assert.equal(hasTopLevelOr('_type == "a" || _type == "b"'), true)
    assert.equal(hasTopLevelOr('_type == "a" && (x || y)'), false)
    assert.equal(hasTopLevelOr('title match "a||b"'), false)
  })

  for (const [name, query] of Object.entries(QUERIES)) {
    it(`keeps every document filter of the ${name} query self-contained and type-restricted`, () => {
      const filters = documentFilters(query)
      assert.ok(filters.length > 0)
      for (const filter of filters) {
        assert.equal(hasTopLevelOr(filter), false, filter)
        assert.match(filter, /^\s*_type == "\w+"/, filter)
      }
    })
  }
})

describe('buildVisualCandidatesQuery', () => {
  it('reads only videoVisualIndex documents and bounds documents, chunks, and lines', () => {
    const query = QUERIES.visual
    assert.deepEqual(
      documentFilters(query).map((filter) => filter.trim().split(' && ')[0]),
      ['_type == "videoVisualIndex"'],
    )
    assert.match(query, /"video": video->\{ _id, _type, videoId \}/)
    assert.ok(query.includes(`[0...${MAX_VISUAL_CANDIDATES}]`))
    assert.ok(query.includes(`[0...${MAX_MOMENTS_PER_VIDEO}]`))
    assert.ok(query.includes(`string::split(text, "\\n")`))
    assert.ok(query.includes(`[0...${MAX_VISUAL_LINES}]`))
    assert.ok(!/\bchunks\s*[,}]/.test(query), 'never projects the whole chunks array')
  })

  it('rejects unsafe or empty terms', () => {
    assert.throws(() => buildVisualCandidatesQuery([]))
    assert.throws(() => buildVisualCandidatesQuery(['x" || true || "']))
  })
})
