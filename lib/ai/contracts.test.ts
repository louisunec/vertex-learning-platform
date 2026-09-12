import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {
  MAX_EVIDENCE_PER_STATEMENT,
  MAX_STATEMENT_LENGTH,
  MAX_STATEMENTS,
  resolvedCitationSchema,
  supportedFeedbackSchema,
} from './contracts.ts'

const ref = {chunkId: 'tc-120-4', chunkRevision: 'rev-1'}

const citation = {
  chunkId: 'tc-120-4',
  lessonId: 'lesson-hooks',
  sourceRevision: 'rev-1',
  startSeconds: 120,
  endSeconds: 150,
  label: 'useState basics',
  href: '/lessons/react-hooks?t=120',
}

describe('supportedFeedbackSchema', () => {
  it('accepts bounded statements with evidence refs', () => {
    const feedback = {
      status: 'partial',
      statements: [
        {text: 'useState returns the current value and a setter.', evidence: [ref]},
        {text: 'Try it on the counter example next.', evidence: []},
      ],
      followUp: 'What happens if you call the setter twice?',
    }
    assert.ok(supportedFeedbackSchema.safeParse(feedback).success)
  })

  it('accepts insufficient evidence with no statements', () => {
    assert.ok(supportedFeedbackSchema.safeParse({status: 'insufficient_evidence', statements: []}).success)
  })

  it('rejects too many statements, overlong text, and too many refs', () => {
    const statement = {text: 'x', evidence: []}
    assert.ok(
      !supportedFeedbackSchema.safeParse({status: 'supported', statements: Array(MAX_STATEMENTS + 1).fill(statement)})
        .success,
    )
    assert.ok(
      !supportedFeedbackSchema.safeParse({
        status: 'supported',
        statements: [{text: 'x'.repeat(MAX_STATEMENT_LENGTH + 1), evidence: []}],
      }).success,
    )
    assert.ok(
      !supportedFeedbackSchema.safeParse({
        status: 'supported',
        statements: [{text: 'x', evidence: Array(MAX_EVIDENCE_PER_STATEMENT + 1).fill(ref)}],
      }).success,
    )
  })

  it('rejects unknown statuses and empty ids', () => {
    assert.ok(!supportedFeedbackSchema.safeParse({status: 'correct', statements: []}).success)
    assert.ok(
      !supportedFeedbackSchema.safeParse({
        status: 'supported',
        statements: [{text: 'x', evidence: [{chunkId: '', chunkRevision: 'rev-1'}]}],
      }).success,
    )
  })
})

describe('resolvedCitationSchema', () => {
  it('accepts an internal lesson href with a start time', () => {
    assert.ok(resolvedCitationSchema.safeParse(citation).success)
    assert.ok(resolvedCitationSchema.safeParse({...citation, href: '/lessons/react-hooks'}).success)
  })

  it('accepts an optional evidence source and rejects unknown ones', () => {
    assert.ok(resolvedCitationSchema.safeParse({...citation, source: 'ocr'}).success)
    assert.ok(resolvedCitationSchema.safeParse({...citation, source: 'vlm'}).success)
    assert.ok(!resolvedCitationSchema.safeParse({...citation, source: 'screenshot'}).success)
  })

  it('rejects a range that ends before it starts', () => {
    assert.ok(!resolvedCitationSchema.safeParse({...citation, endSeconds: 119}).success)
  })

  it('rejects fractional or negative seconds', () => {
    assert.ok(!resolvedCitationSchema.safeParse({...citation, startSeconds: 1.5}).success)
    assert.ok(!resolvedCitationSchema.safeParse({...citation, startSeconds: -1}).success)
  })

  it('rejects external, protocol-relative, and non-lesson hrefs', () => {
    for (const href of [
      'https://evil.test/lessons/react-hooks',
      '//evil.test/lessons/x',
      '/courses/react',
      'javascript:alert(1)',
      '/lessons/react-hooks?t=120&next=https://evil.test',
      '/lessons/a/b',
    ]) {
      assert.ok(!resolvedCitationSchema.safeParse({...citation, href}).success, href)
    }
  })
})
