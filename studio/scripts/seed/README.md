# Seed content

Sample catalogue for local development and search testing: 6 categories,
5 instructors, 10 courses, 40 embedded modules and 120 lesson documents.

- `seed.ndjson` — documents in the shape of `studio/schemaTypes`. Images use
  `_sanityAsset` remote URLs, which `sanity dataset import` uploads.
- `videos.json` — the public YouTube video each lesson embeds; the lesson's
  `durationSeconds` is that video's length. Lesson posters and course covers are
  the YouTube thumbnails of that video / the course's first lesson.
- `validate.mjs` — checks field names against the schema, that every
  reference resolves, that each lesson belongs to exactly one module, and
  prints the derived module/course durations.

Module and course totals are never stored: the web app derives lesson count
and duration from the lesson references (`sanity/queries/fragments.ts`), so a
module always equals the sum of its lessons and a course the sum of its modules.

```bash
cd studio
npm run seed:validate   # offline check
npm run seed:import     # validate, then import with --replace (same ids overwrite);
                        # --allow-failing-assets skips an unreachable image instead of aborting
```

`video` documents (chapters + transcript chunks) are not part of this seed;
they come from the offline ingestion tool.
