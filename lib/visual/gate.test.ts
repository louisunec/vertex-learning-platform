import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {DEFAULT_GATE_CONFIG, hasTranscriptCue, vlmGate, type GateSignals} from './gate.ts'

/** A code screen OCR read cleanly. */
const readableCode: GateSignals = {
  visualChange: 0.2,
  edgeDensity: 0.12,
  ocrConfidence: 92,
  textDensity: 0.18,
  transcriptCue: false,
}

describe('vlmGate', () => {
  it('never calls for a talking head: high change, low edge density, no OCR text', () => {
    const talkingHead: GateSignals = {visualChange: 0.9, edgeDensity: 0.004, ocrConfidence: null, textDensity: 0, transcriptCue: false}
    assert.deepEqual(vlmGate(talkingHead), {call: false, score: 0, reason: 'no_text_structure'})
    assert.equal(vlmGate({...talkingHead, transcriptCue: true}).call, false)
  })

  it('does not call on a deictic transcript cue alone', () => {
    const decision = vlmGate({...readableCode, transcriptCue: true})
    assert.equal(decision.call, false)
    assert.equal(decision.reason, 'below_threshold')
  })

  it('does not call on a frame that did not change', () => {
    const diagram: GateSignals = {visualChange: 0, edgeDensity: 0.1, ocrConfidence: null, textDensity: 0, transcriptCue: true}
    assert.equal(vlmGate(diagram).reason, 'no_visual_change')
  })

  it('does not call when OCR read the screen confidently', () => {
    assert.equal(vlmGate(readableCode).call, false)
  })

  it('calls for unread text-like structure without any transcript cue', () => {
    const diagram: GateSignals = {visualChange: 0.3, edgeDensity: 0.08, ocrConfidence: null, textDensity: 0, transcriptCue: false}
    assert.deepEqual(vlmGate(diagram), {call: true, score: 0.6, reason: 'gated'})
  })

  it('calls for low-confidence OCR when a transcript cue adds weight', () => {
    const garbled = {...readableCode, ocrConfidence: 35, transcriptCue: true}
    assert.equal(vlmGate({...garbled, transcriptCue: false}).call, false)
    assert.equal(vlmGate(garbled).call, true)
  })

  it('respects a configured threshold', () => {
    const diagram: GateSignals = {visualChange: 0.3, edgeDensity: 0.08, ocrConfidence: null, textDensity: 0, transcriptCue: false}
    assert.equal(vlmGate(diagram, {...DEFAULT_GATE_CONFIG, threshold: 0.9}).call, false)
  })
})

describe('hasTranscriptCue', () => {
  const transcript = [
    {startSeconds: 0, endSeconds: 30, text: 'Today we talk about state.'},
    {startSeconds: 30, endSeconds: 60, text: 'As you can see here, the effect runs twice.'},
  ]

  it('finds a visual reference within the window', () => {
    assert.equal(hasTranscriptCue(transcript, 25), true)
    assert.equal(hasTranscriptCue(transcript, 45), true)
  })

  it('ignores cues outside the window and plain speech', () => {
    assert.equal(hasTranscriptCue(transcript, 10), false)
    assert.equal(hasTranscriptCue(transcript, 75), false)
  })
})
