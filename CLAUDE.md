@AGENTS.md

# Claude Code approval rules

For any request that will modify source code, configuration, schemas,
prompts, migrations, or other project files:

1. Inspect the relevant project files and documentation.
2. Prepare the implementation plan.
3. Present the plan to the user for review.
4. STOP and wait for explicit user approval.
5. Only after explicit approval may implementation begin.

The absence or unavailability of an interactive approval mechanism is
NOT approval.

If AskUserQuestion, ExitPlanMode, or another approval mechanism cannot
run in the current session:

- present the implementation plan,
- do not modify project files,
- do not execute implementation commands,
- stop the run after presenting the plan.

Never substitute writing an implementation prompt or documenting a
decision for actual user approval.

Never infer approval because:
- the plan is complete,
- the plan appears correct,
- an implementation prompt exists,
- the approval UI is unavailable,
- the session is non-interactive,
- a previous task was approved.

Only say that a plan is "confirmed" or "approved" when the user has
explicitly approved the current plan.

The user may bypass this gate only by explicitly saying something such
as "implement directly", "skip review", or "proceed without review".