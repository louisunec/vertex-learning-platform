import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {buildSpans} from '../assessments/spans.ts'
import {toSourceChunks} from '../evidence/chunks.ts'
import {
  CONCEPT_EXTRACTION_SYSTEM_PROMPT,
  CONCEPT_FIELD_LIMITS,
  MAX_EXCLUDED_DETAILS,
  buildExtractionPrompt,
  candidateFingerprint,
  candidateIdFor,
  extractionKeyFor,
  extractionOutputSchema,
  filterAliases,
  findIncidentalDetail,
  mapConceptCandidate,
  splitTrailingAbbreviation,
  type GeneratedConcept,
} from './extract.ts'

const video = (text = (i: number) => `chunk ${i}`) => ({
  _id: 'video-youtube-abc',
  durationSeconds: 300,
  transcriptChunks: Array.from({length: 10}, (_, i) => ({_key: `tc-${i}`, startSeconds: i * 30, text: text(i)})),
})
const [span] = buildSpans(toSourceChunks(video()))
const MODEL = 'gpt-5-mini'
const keyInput = {lessonId: 'lesson-csrf', lessonTitle: 'CSRF', videoDocumentId: 'video-youtube-abc', span, model: MODEL}
const context = {lessonId: 'lesson-csrf', span, extractionKey: 'key-1', role: 'primary' as const}

const concept = (overrides: Partial<GeneratedConcept> = {}): GeneratedConcept => ({
  name: 'CSRF tokens',
  aliases: ['anti-CSRF token', 'csrf tokens', 'Synchronizer token'],
  summary: 'A secret, per-session value the server checks on state-changing requests.',
  objectives: ['Explain why a CSRF token blocks forged requests.', 'Explain why a CSRF token blocks forged requests.'],
  sourceChunks: [3, 1, 3],
  ...overrides,
})

const output = (overrides: Record<string, unknown> = {}) => ({primary: concept(), secondary: null, excludedDetails: [], skipReason: null, ...overrides})

describe('extraction output schema (v2)', () => {
  it('allows one primary, at most one secondary with a reason, and bounded excluded details', () => {
    assert.equal(extractionOutputSchema.safeParse(output()).success, true)
    assert.equal(extractionOutputSchema.safeParse(output({primary: null, skipReason: 'intro'})).success, true)
    assert.equal(extractionOutputSchema.safeParse(output({secondary: concept()})).success, false, 'secondary needs independenceReason')
    assert.equal(extractionOutputSchema.safeParse(output({secondary: {...concept(), independenceReason: 'Tested on its own.'}})).success, true)
    assert.equal(extractionOutputSchema.safeParse(output({excludedDetails: Array.from({length: MAX_EXCLUDED_DETAILS + 1}, () => 'x')})).success, false)
    assert.equal(extractionOutputSchema.safeParse(output({primary: concept({objectives: []})})).success, false)
  })

  it('keeps the critical rules inline in the system prompt', () => {
    for (const rule of [/untrusted source data/, /never an incidental fact/, /normally|mainly teaches/, /independently teachable and testable/, /usernames/, /command output/, /only abbreviations/]) {
      assert.match(CONCEPT_EXTRACTION_SYSTEM_PROMPT, rule)
    }
  })

  it('sends one labelled span, never more', () => {
    const prompt = buildExtractionPrompt({lessonTitle: 'CSRF', span})
    assert.match(prompt, /c0 \[0:00\] chunk 0/)
    assert.equal((prompt.match(/^c\d+ /gm) ?? []).length, span.chunks.length)
  })
})

describe('keys and candidate identity', () => {
  it('extraction key is stable for the same inputs and changes with source, title, or model', () => {
    const base = extractionKeyFor(keyInput)
    assert.equal(extractionKeyFor(keyInput), base)
    const [edited] = buildSpans(toSourceChunks(video((i) => (i === 2 ? 'changed' : `chunk ${i}`))))
    assert.notEqual(extractionKeyFor({...keyInput, span: edited}), base)
    assert.notEqual(extractionKeyFor({...keyInput, lessonTitle: 'Renamed'}), base)
    assert.notEqual(extractionKeyFor({...keyInput, model: 'other-model'}), base)
  })

  it('candidate ids are stable per key and role; fingerprints ignore the summary and chunk order', () => {
    assert.equal(candidateIdFor('key-1', 'primary'), candidateIdFor('key-1', 'primary'))
    assert.notEqual(candidateIdFor('key-1', 'primary'), candidateIdFor('key-1', 'secondary'))
    assert.equal(candidateFingerprint('CSRF tokens', ['b', 'a']), candidateFingerprint('csrf token', ['a', 'b']))
    assert.notEqual(candidateFingerprint('CSRF tokens', ['a']), candidateFingerprint('CSRF tokens', ['a', 'b']))
  })
})

describe('deterministic filters (calibrated on the v1 pilot names)', () => {
  it('rejects literal, identifier, and file-name concepts and keeps ordinary names', () => {
    assert.equal(findIncidentalDetail("CSP 'none' source expression"), "'none'")
    assert.equal(findIncidentalDetail('Supplying secrets with terraform.tfvars (and its risk)'), 'terraform.tfvars')
    assert.equal(findIncidentalDetail('TF_VAR environment variables'), 'TF_VAR')
    assert.equal(findIncidentalDetail('Run npm install --save-dev'), '--save-dev')
    assert.equal(findIncidentalDetail('Admin user admin@example.com'), '@')
    for (const name of ['OAuth 2.0 authorization code flow', 'HTTP Strict Transport Security', 'CI/CD pipeline secrets', 'Referrer-Policy header', 'SQL injection']) {
      assert.equal(findIncidentalDetail(name), null, name)
    }
  })

  it('keeps abbreviations, spelling variants, and synonyms; drops comparisons, parentheticals, long and narrower phrases', () => {
    const {kept, dropped} = filterAliases('Session-based cookie authentication', [
      'Server-side sessions',
      'Sessions vs JWTs',
      'Session cookies (HTTP)',
      'Session based cookie authentication',
      'Password hashing for storage and verification',
      'Session-based cookie authentication for admin panels',
      'SBA',
    ])
    assert.deepEqual(kept, ['Server-side sessions', 'Session based cookie authentication', 'SBA'])
    assert.deepEqual(dropped, [
      'Sessions vs JWTs',
      'Session cookies (HTTP)',
      'Password hashing for storage and verification',
      'Session-based cookie authentication for admin panels',
    ])
    // The name plus two qualifier words is a narrower concept.
    assert.deepEqual(filterAliases('SQL injection', ['Blind SQL injection attacks', 'SQLi']).dropped, ['Blind SQL injection attacks'])
    // The name is compared without its trailing parenthetical.
    assert.deepEqual(filterAliases('Parameterized queries (prepared statements)', ['Prepared statements']).kept, ['Prepared statements'])
  })

  it('drops component identifiers (a directive or header value is related, not a synonym)', () => {
    assert.deepEqual(filterAliases('Content Security Policy', ['CSP', 'script-src', 'Content-Security-Policy']), {
      kept: ['CSP', 'Content-Security-Policy'],
      dropped: ['script-src'],
    })
    assert.deepEqual(filterAliases('Referrer-Policy', ['strict-origin-when-cross-origin', 'Referer header']).dropped, ['strict-origin-when-cross-origin'])
    // A lowercase hyphenated spelling of the name is still a variant.
    assert.deepEqual(filterAliases('Brute-force attacks', ['brute-force']).kept, ['brute-force'])
  })

  it('moves a trailing abbreviation from the name into the aliases', () => {
    assert.deepEqual(splitTrailingAbbreviation('Cross-site scripting (XSS)'), {name: 'Cross-site scripting', abbreviation: 'XSS'})
    assert.deepEqual(splitTrailingAbbreviation('Authorization (roles and permissions)'), {
      name: 'Authorization (roles and permissions)',
      abbreviation: null,
    })
  })
})

describe('mapConceptCandidate', () => {
  it('maps span-local indices through the allowlist and copies ids, revisions, and times', () => {
    const mapped = mapConceptCandidate(concept(), context)
    assert.equal(mapped.ok, true)
    if (!mapped.ok) return
    const {candidate} = mapped
    assert.equal(candidate._key, candidateIdFor('key-1', 'primary'))
    assert.equal(candidate.role, 'primary')
    assert.deepEqual(
      candidate.sourceRefs.map((ref) => [ref.chunkId, ref.startSeconds, ref.endSeconds, ref.lesson._ref]),
      [
        ['video-youtube-abc:tc-1', 30, 60, 'lesson-csrf'],
        ['video-youtube-abc:tc-3', 90, 120, 'lesson-csrf'],
      ],
    )
    assert.equal(candidate.sourceRefs[0].chunkRevision, span.chunks[1].chunkRevision)
    assert.equal(candidate.fingerprint, candidateFingerprint('CSRF tokens', ['video-youtube-abc:tc-1', 'video-youtube-abc:tc-3']))
  })

  it('drops aliases that repeat the name, repeated objectives, and filtered aliases', () => {
    const mapped = mapConceptCandidate(concept({aliases: ['csrf tokens', 'anti-CSRF token', 'CSRF vs CORS']}), context)
    assert.ok(mapped.ok)
    if (!mapped.ok) return
    assert.deepEqual(mapped.candidate.aliases, ['anti-CSRF token'])
    assert.deepEqual(mapped.droppedAliases, ['CSRF vs CORS'])
    assert.equal(mapped.candidate.objectives.length, 1)
  })

  it('moves an abbreviation out of the name', () => {
    const mapped = mapConceptCandidate(concept({name: 'Cross-site request forgery (CSRF)', aliases: []}), context)
    assert.ok(mapped.ok)
    if (!mapped.ok) return
    assert.equal(mapped.candidate.name, 'Cross-site request forgery')
    assert.deepEqual(mapped.candidate.aliases, ['CSRF'])
  })

  it('keeps the independence reason of a secondary', () => {
    const mapped = mapConceptCandidate({...concept(), independenceReason: 'Assessable without the primary.'}, {...context, role: 'secondary'})
    assert.ok(mapped.ok)
    if (!mapped.ok) return
    assert.equal(mapped.candidate.role, 'secondary')
    assert.equal(mapped.candidate.independenceReason, 'Assessable without the primary.')
  })

  const rejected = (overrides: Partial<GeneratedConcept>) => {
    const mapped = mapConceptCandidate(concept(overrides), context)
    return mapped.ok ? null : mapped.reason
  }

  it('rejects chunks outside the span, over-limit text, and cut-off summaries', () => {
    assert.equal(rejected({sourceChunks: [0, span.chunks.length]}), 'source_out_of_span')
    assert.equal(rejected({summary: `${'a'.repeat(CONCEPT_FIELD_LIMITS.summary)}.`}), 'field_too_long:summary')
    assert.equal(rejected({aliases: ['x'.repeat(CONCEPT_FIELD_LIMITS.alias + 1)]}), 'field_too_long:alias0')
    assert.equal(rejected({summary: 'A secret value the server checks on'}), 'truncated_text:summary')
  })

  it('rejects incidental details, source language, chunk labels, and empty names', () => {
    assert.equal(rejected({name: 'TF_VAR environment variables'}), 'incidental_detail:TF_VAR')
    assert.equal(rejected({summary: 'The instructor shows a secret value.'}), 'generator_language:instructor')
    assert.equal(rejected({objectives: ['Explain the idea from c3.']}), 'chunk_label:c3')
    assert.equal(rejected({name: '—'}), 'empty_name')
  })

  it('keeps an audit copy of every rejected candidate', () => {
    const mapped = mapConceptCandidate(concept({name: 'TF_VAR environment variables'}), context)
    assert.equal(mapped.ok, false)
    if (mapped.ok) return
    assert.deepEqual(
      {candidateId: mapped.rejected.candidateId, name: mapped.rejected.name, reason: mapped.rejected.reason, role: mapped.rejected.role},
      {candidateId: candidateIdFor('key-1', 'primary'), name: 'TF_VAR environment variables', reason: 'incidental_detail:TF_VAR', role: 'primary'},
    )
    assert.ok(mapped.rejected.fingerprint)
  })
})
