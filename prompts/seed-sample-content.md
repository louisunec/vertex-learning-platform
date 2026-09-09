# Seed sample content

## Goal

Populate the `production` dataset with realistic sample content — a handful of
instructors and categories, and 10+ courses with modules and lessons across
programming, web development, data, infrastructure, security and AI — so the
catalogue and cross-course search have real data. Module and course totals must
be consistent: a module equals the sum of its lessons, a course the sum of its
modules.

## Guidance read

- `AGENTS.md` §2, §6, §7, §12 (content-model invariants, workspace split, verification).
- `docs/DATA_MODEL.md` §2–§5, §10 (derived values), §12 (referential integrity).
- `studio/schemaTypes/**` — the canonical field names and enums.
- `sanity/queries/fragments.ts`, `sanity/lib/curriculum.ts` — how the web app derives
  `lessonCount`, `moduleCount` and `durationSeconds` from lesson references.
- `components/ui/icon.tsx` — the design-system icon names `learningOutcome.icon` may use.

## Code inspected

- Untracked `studio/scripts/seed/seed.ndjson` (141 docs) and `videos.json` (120 public
  YouTube videos with real durations) already existed and had been imported once.
- The dataset held those 141 documents + 125 uploaded image assets, 0 drafts,
  0 `progress`, 0 `video` documents.
- The seed was written against an older field set: `lesson.duration`/`thumbnail`/
  `studentCount`, `course.price`/`studentCount`, block-array `instructor.bio`,
  resource `type: "link"`, and icon names not in the design system. As a result the
  catalogue's derived `durationSeconds` summed to 0 and `poster`/`priceDisplay` were null.

## Decisions / assumptions

1. **Nothing aggregate is stored.** The schema has no module/course duration or
   lesson-count field; consistency is guaranteed structurally because the web derives
   them from `modules[].lessons[]->durationSeconds`. The fix is to make every lesson
   carry a correct `durationSeconds` (= its video length) and every lesson belong to
   exactly one module.
2. **Transform the existing seed in place** rather than regenerate it: rename fields to
   the schema names, convert `bio` to plain text, map resource types into the enum,
   map icons into `IconName`. Authored prose is untouched. `price` → `priceDisplay`
   (`"$99"` / `"Free"`), `studentCount` → `studentCountDisplay` (`"18,240 students"`).
3. **Keep a validator** (`studio/scripts/seed/validate.mjs`) that enforces a per-type
   field allowlist, reference resolution, one-module-per-lesson, duration = video
   length, and prints the derived totals. `npm run seed:import` runs it before importing.
4. **Import with `--replace`.** Every target id belongs to this seed; replacing drops the
   stale fields from the live documents. No user-authored content or progress exists.
5. **No `video` documents.** `videos.json` has no chapters or transcripts; fabricating
   timestamps would violate the grounding invariant. Video-moment search stays empty
   until the offline ingestion tool runs.
6. **Course covers come from YouTube thumbnails** (`maxresdefault.jpg` of the course's
   first lesson). The original seed used picsum.photos, which returned 503/522 during
   import and aborted the asset step — which is also why no cover assets existed after
   the first import. `seed:import` passes `--allow-failing-assets` so one unreachable
   image is skipped rather than leaving every image field unlinked.
7. No web code changes; queries already project the schema field names.

## Files

- `studio/scripts/seed/seed.ndjson` (rewritten field names)
- `studio/scripts/seed/validate.mjs` (new)
- `studio/scripts/seed/README.md` (new)
- `studio/package.json` (`seed:validate`, `seed:import` scripts)

## Security

Import runs with the developer's Sanity CLI login from the Studio workspace; no token
is added to any env file or shipped to the browser.

## Acceptance criteria

- `npm run seed:validate` exits 0 and lists 10 courses × 4 modules, 120 lessons.
- `sanity documents validate` reports no errors for the seeded types.
- GROQ: every course has non-null `math::sum(modules[].lessons[]->durationSeconds)`
  equal to the validator's total; every lesson has `durationSeconds` and `poster`.

## Manual test

1. `cd studio && npm run seed:import`
2. `npx sanity documents validate --api-version 2026-08-31`
3. Open the Studio → Courses → any course → Curriculum: 4 modules, lesson previews show minutes.
