import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import type {SourceChunk} from '../evidence/chunks.ts'
import {familyIdFor, mapCandidate, type AssessmentDraft, type GeneratedItem} from './generate.ts'
import type {GenerationRecord} from './pipeline.ts'
import {
  findChunkLabel,
  findGeneratorLanguage,
  findPositionalReference,
  findSourcePointer,
  hasAnswerLengthCue,
  looksCorrupted,
  looksTruncated,
  seededShuffle,
  summarizeCandidates,
} from './quality.ts'
import type {Span} from './spans.ts'

const chunk = (i: number): SourceChunk => ({
  chunkId: `video-x:tc-${i}`,
  chunkRevision: `rev${i}`,
  source: 'transcript',
  startSeconds: i * 20,
  endSeconds: i * 20 + 20,
  text: `chunk ${i}`,
})
const span: Span = {index: 0, chapterLabel: null, chunks: [chunk(0), chunk(1)], startSeconds: 0, endSeconds: 40}

const item = (options: string[], overrides: Partial<GeneratedItem> = {}): GeneratedItem => ({
  objective: 'Choose the storage for secrets.',
  type: 'apply',
  question: 'Where should an API key for a server job live?',
  options: options.map((text, i) => ({
    text,
    correct: i === 0,
    reason: i === 0 ? 'It keeps keys out of code and logs.' : 'Anyone who can read it can copy the key.',
  })),
  hints: {direction: 'Think about who can read the value.', keyConcept: 'Keep credentials out of source control.', solution: 'A secrets manager.'},
  sourceChunks: [0],
  ...overrides,
})

function map(options: string[], lessonId: string, overrides: Partial<GeneratedItem> = {}): AssessmentDraft {
  const result = mapCandidate(item(options, overrides), {
    lessonId,
    span,
    spanKey: `key-${lessonId}`,
    familyId: familyIdFor(lessonId, 0, 0),
    ordinal: 0,
    version: 1,
    model: 'gpt-5-mini',
    generatedAt: new Date('2026-09-12T00:00:00Z'),
  })
  assert.ok(result.ok, `rejected: ${JSON.stringify(result)}`)
  return result.doc
}

const FOUR = ['A secrets manager', 'The repository README', 'A public gist', 'The frontend bundle']
const THREE = FOUR.slice(0, 3)

describe('seededShuffle', () => {
  it('is a deterministic permutation of its input', () => {
    const items = ['a', 'b', 'c', 'd']
    assert.deepEqual(seededShuffle(items, 'seed-1'), seededShuffle(items, 'seed-1'))
    assert.deepEqual(seededShuffle(items, 'seed-1').toSorted(), items)
    assert.deepEqual(items, ['a', 'b', 'c', 'd'])
  })
})

describe('option order in generated drafts', () => {
  it('keeps the same order for the same assessment version and keeps the answer key on the correct text', () => {
    const first = map(FOUR, 'lesson-a')
    const again = map(FOUR, 'lesson-a')
    assert.deepEqual(first.options, again.options)
    const correct = first.options.findIndex((option) => option._key === first.answerKey.correctOptionId)
    assert.equal(first.options[correct].text, 'A secrets manager')
  })

  it('spreads a model-first answer evenly across every position (4 and 3 options)', () => {
    for (const options of [FOUR, THREE]) {
      const counts = Array.from({length: options.length}, () => 0)
      for (let i = 0; i < 1200; i++) {
        const doc = map(options, `lesson-${i}`)
        counts[doc.options.findIndex((option) => option._key === doc.answerKey.correctOptionId)]++
      }
      const expected = 1 / options.length
      for (const count of counts) {
        assert.ok(Math.abs(count / 1200 - expected) <= 0.05, `positions ${counts.join('/')} for ${options.length} options`)
      }
    }
  })
})

describe('findGeneratorLanguage', () => {
  it('flags each word that describes the generator input', () => {
    for (const text of [
      'In this span, the author explains CSRF.',
      'The passage lists three headers.',
      'As the speaker says, rotate keys.',
      'The transcript mentions bcrypt.',
      'Re-read the section on cookies.',
      'According to the text, salts are random.',
      'The excerpt defines XSS.',
      'Chunks 2 and 3 describe tokens.',
      'The presenter recommends MFA.',
      'This video covers OAuth.',
      'The lesson says to use HTTPS.',
      'The instructor warns against plain text.',
      'In the demo, the token is rotated.',
      'The demonstration uses Vault.',
      'Following the demonstrated practice, mark it sensitive.',
    ]) {
      assert.ok(findGeneratorLanguage(text), text)
    }
  })

  it('does not flag ordinary subject vocabulary', () => {
    for (const text of [
      'Session cookies expire when the browser closes.',
      'Store sessions server-side.',
      'The subsection of the RFC defines SameSite.',
      'Attackers exploit the expanse of exposed endpoints.',
      'A C2 server receives beacons.',
      'The Content-Security-Policy header limits script sources.',
      'Spanish translations use the same keys.',
      'The exploit has been demonstrated in the wild.',
    ]) {
      assert.equal(findGeneratorLanguage(text), null, text)
    }
  })

  it('known cost: legitimate uses of "section" are rejected too', () => {
    assert.equal(findGeneratorLanguage('Add the directive to the CSP header section.'), 'section')
  })
})

describe('findSourcePointer', () => {
  it('flags directions to text learners cannot see', () => {
    for (const text of [
      'Find the line that expands the acronym.',
      'Look at the part where user input replaces the credential.',
      'Review the lines describing object conversion.',
      'Refer to the statement about closing the tab.',
      'Look for the sentence that suggests a configuration change.',
      'Look at the guidance that compares two approaches.',
      'Check the recommendation for storing tokens.',
    ]) {
      assert.ok(findSourcePointer(text), text)
    }
  })

  it('does not flag subject matter that uses the same nouns', () => {
    for (const text of [
      'Delete the first two lines of the config file.',
      'Look at the example request below.',
      'The SQL statement runs with bound parameters.',
      'Remove HTML comments that expose internal paths.',
      'Which part of the URL does the attacker control?',
    ]) {
      assert.equal(findSourcePointer(text), null, text)
    }
  })
})

describe('findChunkLabel', () => {
  it('flags internal chunk labels', () => {
    assert.equal(findChunkLabel('Look in c0–c1 for the header.'), 'c0')
    assert.equal(findChunkLabel('As stated (c3), salts are random.'), 'c3')
    assert.equal(findChunkLabel('Stated in c12.'), 'c12')
  })

  it('does not flag uppercase codes or labels inside other tokens', () => {
    for (const text of ['A C2 server receives beacons.', 'Use sec1 as the key name.', 'The abc1 value is random.', 'Set x-c1 in the header.']) {
      assert.equal(findChunkLabel(text), null, text)
    }
  })
})

describe('findPositionalReference', () => {
  it('flags options named by number, capital letter, or position', () => {
    for (const text of ['Option 1 is correct.', 'option B caches values', 'Answer (C) is wrong.', 'choice 4', 'The first option re-renders.', 'the last answer']) {
      assert.ok(findPositionalReference(text), text)
    }
  })

  it('does not flag ordinary prose', () => {
    for (const text of ['Users answer a question.', 'OAuth 2 offers several options.', 'Choose option-specific flags.', 'It answers 2FA prompts.', 'Pick the choice 42 times.']) {
      assert.equal(findPositionalReference(text), null, text)
    }
  })
})

describe('looksTruncated and looksCorrupted', () => {
  it('flags text that stops mid-word and accepts finished sentences', () => {
    assert.ok(looksTruncated("so the value cannot change the query's struc"))
    assert.ok(looksTruncated('and is not a‑'))
    for (const text of ['It re-renders.', 'Which hook fits?', 'Use "sensitive = true".', 'Mark it (sensitive).', '它保存状态。', '应该使用哪个？']) {
      assert.equal(looksTruncated(text), false, text)
    }
  })

  it('flags stray CJK tokens in Latin text but not text written in a CJK script', () => {
    for (const text of ['the system must first confirm誰', 'can\'t be easily attributed or短', 'escaping them first 쿼리语', 'A shared account that changes monthly is wrong因为a']) {
      assert.ok(looksCorrupted(text), text)
    }
    for (const text of ['它保存状态，并在 useState 改变时重新渲染。', 'Plain English only.', 'Café naïve résumé.']) {
      assert.equal(looksCorrupted(text), false, text)
    }
  })
})

describe('hasAnswerLengthCue', () => {
  const pad = (length: number) => 'x'.repeat(length)
  it('flags a correct option at least 1.4× and 15 characters longer than every distractor', () => {
    assert.ok(hasAnswerLengthCue([pad(56), pad(40), pad(20), pad(10)], 0))
  })

  it('accepts options just under the ratio, short options under the gap floor, and ties', () => {
    assert.equal(hasAnswerLengthCue([pad(55), pad(40), pad(20)], 0), false)
    assert.equal(hasAnswerLengthCue([pad(14), pad(5), pad(4)], 0), false)
    assert.equal(hasAnswerLengthCue([pad(40), pad(40), pad(12)], 0), false)
    assert.equal(hasAnswerLengthCue([pad(10), pad(60), pad(12)], 0), false)
  })
})

describe('summarizeCandidates', () => {
  it('reports types, correct positions, length ratios, rejection reasons, and outcomes', () => {
    const drafts = [map(FOUR, 'lesson-a'), map(THREE, 'lesson-b', {type: 'transfer'})]
    const record = (kind: GenerationRecord['kind'], outcome: GenerationRecord['outcome'], reasons: string[]) =>
      ({kind, outcome, rejectionReasons: reasons}) as GenerationRecord
    const summary = summarizeCandidates(drafts, [
      record('section', 'drafted', ['answer_length_cue']),
      record('section', 'all_rejected', ['generator_language:section', 'generator_language:span']),
      record('lesson_transfer', 'no_candidates', []),
    ])
    assert.equal(summary.candidates, 2)
    assert.deepEqual(summary.byType, {recall: 0, apply: 1, transfer: 1})
    assert.equal(summary.correctPosition['4'].reduce((a, b) => a + b), 1)
    assert.equal(summary.correctPosition['3'].reduce((a, b) => a + b), 1)
    assert.equal(Object.values(summary.lengthRatio).reduce((a, b) => a + b), 2)
    assert.deepEqual(summary.rejectionReasons, {answer_length_cue: 1, generator_language: 2})
    assert.deepEqual(summary.rejectionDetails, {answer_length_cue: 1, 'generator_language:section': 1, 'generator_language:span': 1})
    assert.deepEqual(summary.outcomes.section, {drafted: 1, no_candidates: 0, all_rejected: 1})
    assert.deepEqual(summary.outcomes.lesson_transfer, {drafted: 0, no_candidates: 1, all_rejected: 0})
  })
})
