import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {createBudget, DEFAULT_VISUAL_CONFIG, estimateCostUsd, mergeSpans, readVisualConfig} from './budget.ts'

const pricing = {inputUsdPerMTok: 1, outputUsdPerMTok: 10, estimatedInputTokens: 1000}
const caps = {maxFrames: 2, maxOcrFrames: 1, maxVlmCalls: 2, maxWallMs: 1000, maxSpendUsd: 0.02}

describe('createBudget', () => {
  it('refuses frames and OCR passes past their caps', () => {
    const budget = createBudget({caps, pricing})
    assert.deepEqual([budget.takeFrame(), budget.takeFrame(), budget.takeFrame()], [true, true, false])
    assert.deepEqual([budget.takeOcr(), budget.takeOcr()], [true, false])
    const coverage = budget.coverage()
    assert.equal(coverage.framesSampled, 2)
    assert.equal(coverage.framesOcrd, 1)
  })

  it('refuses a VLM call past the call cap', () => {
    const budget = createBudget({caps: {...caps, maxSpendUsd: 10}, pricing})
    assert.deepEqual([budget.takeVlm(100), budget.takeVlm(100), budget.takeVlm(100)], ['ok', 'ok', 'vlm_cap'])
    assert.equal(budget.coverage().vlmCalls, 2)
  })

  it('refuses a VLM call whose worst case would exceed the spend cap', () => {
    // Worst case per call: 1000 in × $1/M + 1000 out × $10/M = $0.011.
    const budget = createBudget({caps, pricing})
    assert.equal(budget.takeVlm(1000), 'ok')
    budget.recordVlmUsage({inputTokens: 1000, outputTokens: 1000}, 1000)
    assert.equal(budget.takeVlm(1000), 'spend_cap')
    assert.equal(budget.coverage().estimatedCostUsd, 0.011)
  })

  it('charges unknown usage at the worst-case estimate', () => {
    const budget = createBudget({caps, pricing})
    budget.recordVlmUsage({inputTokens: null, outputTokens: null}, 500)
    assert.equal(budget.coverage().estimatedCostUsd, estimateCostUsd(pricing, 1000, 500))
  })

  it('tracks wall time with the injected clock', () => {
    let time = 0
    const budget = createBudget({caps, pricing}, () => time)
    assert.equal(budget.wallTimeExceeded(), false)
    time = 1000
    assert.equal(budget.wallTimeExceeded(), true)
    assert.equal(budget.coverage().durationMs, 1000)
  })

  it('is complete until something is skipped, then partial with the span', () => {
    const budget = createBudget({caps, pricing})
    assert.equal(budget.coverage().partial, false)
    budget.skip(10.5, 20.2, 'ocr_cap')
    assert.deepEqual(budget.coverage().skippedSpans, [{startSeconds: 10, endSeconds: 21, reason: 'ocr_cap'}])
    assert.equal(budget.coverage().partial, true)
  })
})

describe('mergeSpans', () => {
  it('joins touching spans with the same reason and keeps different reasons apart', () => {
    assert.deepEqual(
      mergeSpans([
        {startSeconds: 4, endSeconds: 6, reason: 'ocr_cap'},
        {startSeconds: 0, endSeconds: 2, reason: 'ocr_cap'},
        {startSeconds: 2, endSeconds: 4, reason: 'ocr_cap'},
        {startSeconds: 3, endSeconds: 5, reason: 'vlm_cap'},
      ]),
      [
        {startSeconds: 0, endSeconds: 6, reason: 'ocr_cap'},
        {startSeconds: 3, endSeconds: 5, reason: 'vlm_cap'},
      ],
    )
  })
})

describe('readVisualConfig', () => {
  it('uses defaults without env values', () => {
    assert.deepEqual(readVisualConfig({}), DEFAULT_VISUAL_CONFIG)
  })

  it('applies valid overrides and ignores invalid ones', () => {
    const config = readVisualConfig({
      VISUAL_MAX_VLM_CALLS: '0',
      VISUAL_MAX_FRAMES: '12.5',
      VISUAL_MAX_SPEND_USD: 'lots',
      VISUAL_VLM_INPUT_USD_PER_MTOK: '0.4',
      VISUAL_SCENE_THRESHOLD: '0.2',
    })
    assert.equal(config.caps.maxVlmCalls, 0)
    assert.equal(config.caps.maxFrames, DEFAULT_VISUAL_CONFIG.caps.maxFrames)
    assert.equal(config.caps.maxSpendUsd, DEFAULT_VISUAL_CONFIG.caps.maxSpendUsd)
    assert.equal(config.pricing.inputUsdPerMTok, 0.4)
    assert.equal(config.sampling.sceneThreshold, 0.2)
  })
})
