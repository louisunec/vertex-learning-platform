import {SOLUTION_HELP_LEVEL} from '../learner/evidence.ts'

/**
 * Explicit help policy, V1 (development plan §5 PR-5). Pure: the help
 * service supplies the level already recorded for the task instance and
 * persists the decision; the client never supplies a level. Mastery is
 * advisory and never withholds requested help, so it is not an input.
 *
 * Rules, in precedence order:
 * 1. Reference mode, or an explicit solution request → level 3.
 * 2. A request too ambiguous to help with → level 0 (one clarifying question).
 * 3. A first hint request on a task → level 1; repeating it re-shows the
 *    current level and never escalates.
 * 4. An explicit escalation → one level up (1 → 2 → 3), staying at 3.
 * 5. A solution request goes straight to 3 (rule 1), not `previous + 1`.
 *
 * Progression is per task instance: a new task starts its own sequence.
 */

export const HELP_POLICY_VERSION = 'help-v1'

export const HELP_MODES = ['study', 'reference'] as const
export type HelpMode = (typeof HELP_MODES)[number]

export const HELP_REQUESTS = ['hint', 'escalate', 'solution'] as const
export type HelpRequestKind = (typeof HELP_REQUESTS)[number]

export const HELP_REASON_CODES = [
  'reference_mode',
  'explicit_solution',
  'clarification_needed',
  'first_help',
  'repeat_current',
  'escalation',
  'already_at_solution',
] as const
export type HelpReasonCode = (typeof HELP_REASON_CODES)[number]

export type HelpLevel = 0 | 1 | 2 | 3

export type HelpPolicyInput = {
  mode: HelpMode
  request: HelpRequestKind
  /** Highest level already given on this task instance (0 = none). */
  currentLevel: HelpLevel
  /** The request cannot be answered without clarifying it (free-text tutor, PR-6). */
  ambiguous?: boolean
}

export type HelpDecision = {
  level: HelpLevel
  reasonCode: HelpReasonCode
  /** The level skips past the next step of the ladder. */
  explicitOverride: boolean
  policyVersion: typeof HELP_POLICY_VERSION
}

function decision(level: HelpLevel, reasonCode: HelpReasonCode, currentLevel: HelpLevel): HelpDecision {
  return {level, reasonCode, explicitOverride: level > currentLevel + 1, policyVersion: HELP_POLICY_VERSION}
}

export function decideHelpLevel({mode, request, currentLevel, ambiguous = false}: HelpPolicyInput): HelpDecision {
  if (!Number.isInteger(currentLevel) || currentLevel < 0 || currentLevel > SOLUTION_HELP_LEVEL) {
    throw new RangeError(`Invalid current help level: ${currentLevel}`)
  }
  if (mode === 'reference') return decision(SOLUTION_HELP_LEVEL, 'reference_mode', currentLevel)
  if (request === 'solution') return decision(SOLUTION_HELP_LEVEL, 'explicit_solution', currentLevel)
  if (ambiguous) return decision(0, 'clarification_needed', currentLevel)
  if (currentLevel === 0) return decision(1, 'first_help', currentLevel)
  if (request === 'hint') return decision(currentLevel, 'repeat_current', currentLevel)
  if (currentLevel === SOLUTION_HELP_LEVEL) return decision(SOLUTION_HELP_LEVEL, 'already_at_solution', currentLevel)
  return decision((currentLevel + 1) as HelpLevel, 'escalation', currentLevel)
}
