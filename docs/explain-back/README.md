# Explanation tasks: drafts and evaluation

A real explanation task holds a private rubric: each point states what an accurate explanation conveys, which is the answer. Its evaluation cases hold accurate synthetic explanations, which are answers too. So real tasks and their cases live in the gitignored `docs/explain-back/local/` and are never committed. This folder holds only the public format example, `example.cases.json`, written over the synthetic test task in `lib/explain/test-fixtures.ts`, a made-up baking lesson.

## Drafting a task

1. Write `docs/explain-back/local/<task>.task.json`: `taskId`, `lessonSlug`, `title`, `prompt`, and 1–5 `criteria`. Each criterion has `key`, `label`, `point`, `required`, `conceptId`, an optional `objectiveKey`, and `sourceChunkKeys`.
2. Run `npm run draft:explanation-task -- docs/explain-back/local/<task>.task.json --out docs/explain-back/local/<task>.draft.ndjson`. It reads Sanity and never writes to it, and resolves chunk revisions and times on the server.
3. An editor imports the file (from `studio/`: `npx sanity dataset import <file> <dataset> --missing`), then reviews and publishes it in the Studio. Publishing needs all six review checks, version 1 first, and exactly version + 1 for any content change.

## Evaluating a task

`npm run eval:explain -- [--draft <file.ndjson>] [--cases <file.json>] [--case <id>] [--report <file.md>]`

- The draft and cases default to the pilot task's files in `docs/explain-back/local/`.
- It makes one model call per case step. The full JSON (raw model output, gated feedback and removed text) goes to `docs/evals/local/`.
- A `--report` quotes the synthetic explanations and the feedback, so write it under a `local/` directory too.
- Cases follow `explainEvalCaseSchema` (`lib/explain/eval-check.ts`). A case has 1–3 steps: each later step is the learner's revision after reading the feedback, and each step is checked on its own.
- Expectations are fixed before the first run. Structural checks (the contract and the server gates) are reported separately from expectations (the acceptable statuses per point). Neither one is a person's reading of the feedback.

The public summary of the pilot evaluation is `docs/evals/pr-8-explain-review-packet.md`.
