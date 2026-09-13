import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {decideHelpLevel, HELP_POLICY_VERSION, type HelpLevel, type HelpPolicyInput} from './help-policy.ts'

type Row = [input: HelpPolicyInput, level: HelpLevel, reasonCode: string, explicitOverride: boolean]

const check = (rows: Row[]) => {
  for (const [input, level, reasonCode, explicitOverride] of rows) {
    assert.deepEqual(
      decideHelpLevel(input),
      {level, reasonCode, explicitOverride, policyVersion: HELP_POLICY_VERSION},
      JSON.stringify(input),
    )
  }
}

describe('decideHelpLevel', () => {
  it('applies the rules in precedence order: reference, solution, ambiguous, first help, escalation', () => {
    check([
      [{mode: 'reference', request: 'hint', currentLevel: 0, ambiguous: true}, 3, 'reference_mode', true],
      [{mode: 'reference', request: 'solution', currentLevel: 0}, 3, 'reference_mode', true],
      [{mode: 'study', request: 'solution', currentLevel: 0, ambiguous: true}, 3, 'explicit_solution', true],
      [{mode: 'study', request: 'hint', currentLevel: 0, ambiguous: true}, 0, 'clarification_needed', false],
      [{mode: 'study', request: 'escalate', currentLevel: 2, ambiguous: true}, 0, 'clarification_needed', false],
      [{mode: 'study', request: 'hint', currentLevel: 0}, 1, 'first_help', false],
      [{mode: 'study', request: 'escalate', currentLevel: 1}, 2, 'escalation', false],
    ])
  })

  it('gives reference mode the solution at any level', () => {
    check([
      [{mode: 'reference', request: 'hint', currentLevel: 0}, 3, 'reference_mode', true],
      [{mode: 'reference', request: 'escalate', currentLevel: 1}, 3, 'reference_mode', true],
      [{mode: 'reference', request: 'hint', currentLevel: 2}, 3, 'reference_mode', false],
      [{mode: 'reference', request: 'hint', currentLevel: 3}, 3, 'reference_mode', false],
    ])
  })

  it('sends a solution request straight to level 3, flagging a skipped step as an explicit override', () => {
    check([
      [{mode: 'study', request: 'solution', currentLevel: 0}, 3, 'explicit_solution', true],
      [{mode: 'study', request: 'solution', currentLevel: 1}, 3, 'explicit_solution', true],
      [{mode: 'study', request: 'solution', currentLevel: 2}, 3, 'explicit_solution', false],
      [{mode: 'study', request: 'solution', currentLevel: 3}, 3, 'explicit_solution', false],
    ])
  })

  it('climbs the ladder one explicit escalation at a time: 0 → 1 → 2 → 3 → 3', () => {
    check([
      [{mode: 'study', request: 'escalate', currentLevel: 0}, 1, 'first_help', false],
      [{mode: 'study', request: 'escalate', currentLevel: 1}, 2, 'escalation', false],
      [{mode: 'study', request: 'escalate', currentLevel: 2}, 3, 'escalation', false],
      [{mode: 'study', request: 'escalate', currentLevel: 3}, 3, 'already_at_solution', false],
    ])
  })

  it('re-shows the current level for a repeated hint request and never escalates', () => {
    check([
      [{mode: 'study', request: 'hint', currentLevel: 1}, 1, 'repeat_current', false],
      [{mode: 'study', request: 'hint', currentLevel: 2}, 2, 'repeat_current', false],
      [{mode: 'study', request: 'hint', currentLevel: 3}, 3, 'repeat_current', false],
    ])
  })

  it('starts a new task instance at level 1, whatever earlier tasks reached', () => {
    // The caller passes the level recorded for this instance only, so a task change is currentLevel 0.
    check([[{mode: 'study', request: 'hint', currentLevel: 0}, 1, 'first_help', false]])
  })

  it('rejects an impossible current level', () => {
    for (const currentLevel of [-1, 4, 1.5, Number.NaN]) {
      assert.throws(() => decideHelpLevel({mode: 'study', request: 'hint', currentLevel: currentLevel as HelpLevel}), RangeError)
    }
  })
})
