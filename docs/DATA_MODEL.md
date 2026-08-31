# Vertex Data Model

## 1. Modeling principles

Vertex separates:

- authored learning content,
- internal video-search support data,
- learner-specific application state,
- search configuration.

Use references and derived relationships deliberately.

Do not duplicate data merely to make one query convenient unless a measured requirement justifies denormalization.

---

## 2. Course

A `course` is a top-level Sanity document.

It contains:

- title,
- slug,
- summary/marketing description,
- cover image,
- level,
- price display field,
- optional popular flag,
- student-count display field,
- learning outcomes,
- instructor reference,
- category reference,
- ordered modules.

### Learning outcomes

A short ordered list.

Each outcome contains:

- icon,
- title,
- description.

### Modules

Modules are **embedded objects inside the course**, not standalone documents.

Each module contains:

- title,
- summary,
- ordered references to lessons.

Do not store canonical `Module 1`, `Module 2`, etc. numbering. Derive module number from array order.

---

## 3. Lesson

A `lesson` is a Sanity document.

It contains:

- title,
- slug,
- video URL,
- poster/thumbnail,
- duration,
- free-preview display flag,
- student-count display field,
- notes in Portable Text,
- key points,
- optional pro tip,
- resources.

### Resources

A resource includes:

- type,
- title,
- description,
- URL.

### Parent relationship

A lesson does **not** store its parent course as canonical data.

When course/module context is required, derive it from the course that references the lesson.

Do not add a duplicated parent-course field without an explicit data-model change.

---

## 4. Instructor

An `instructor` is a document containing:

- name,
- slug,
- photo,
- expertise,
- bio.

Instructor information appears on relevant course/lesson surfaces and has its own learner-facing page.

---

## 5. Category

A `category` is a document containing:

- title,
- slug,
- description.

Courses reference categories.

---

## 6. Video

A `video` document is internal search/playback support data.

There is one video document per unique normalized video URL.

It contains at least:

- stable id,
- source URL,
- timestamped chapters,
- timestamped transcript chunks.

### Chapters

```ts
{
  startSeconds: number
  label: string
}
```

### Transcript chunks

```ts
{
  startSeconds: number
  text: string
}
```

Do not store/retrieve the transcript as one giant field for request-path use.

Video documents are not independently displayed in learner-facing search results.

A video result is always resolved through the lesson that uses the video's URL.

---

## 7. Search Context

The search Context document stores configurable search-agent context such as:

- content-scope filter,
- concise query/search guidance.

It is configuration data.

It is not:

- the runtime result contract,
- the source of truth for ranking weights,
- a replacement for application authorization.

---

## 8. Progress

A progress record represents learner-specific state.

It is keyed/owned by the authenticated Clerk user identity.

It captures at least:

- completed lesson state,
- last/resume position for a lesson.

Exact persistence shape should follow the project's canonical schema and expected query/write patterns.

### Rules

- progress remains separate from authored course/lesson content,
- the browser does not write it directly,
- server-side code resolves the authenticated user,
- client-supplied user ids must not be trusted as authority.

---

## 9. Portable Text

Lesson notes use Portable Text.

Do not store canonical lesson notes as Markdown.

When search requires text matching over notes:

- project Portable Text into searchable plain text or use an existing supported helper/pattern,
- do not assume raw Portable Text arrays behave as simple strings.

Rendering should use the project's existing Portable Text renderer.

---

## 10. Derived values

Prefer deterministic derivation for values whose truth comes from structure.

Examples:

- module number from module order,
- lesson number from lesson reference order,
- course context for a lesson from reverse reference,
- video result's lesson/course context from real relationships.

Do not persist duplicate labels solely for display convenience unless there is a clear performance/authoring need.

---

## 11. IDs and slugs

Use Sanity/project conventions for document ids and slugs.

Video ids should be deterministically derived from normalized source URLs while stripping/replacing characters rejected by the datastore.

The normalization algorithm should be stable and tested so repeat ingestion updates the same logical video rather than creating duplicates.

---

## 12. Referential integrity expectations

Implementation should account for:

- missing instructor/category references,
- lessons removed from modules,
- a lesson video URL with no ingested video record,
- duplicate video URLs,
- malformed/empty chapter or transcript arrays.

Search must fail/degrade safely when relationships cannot be resolved.

Do not fabricate relationship data to complete a result.

---

## 13. Schema evolution

Schema changes are high-risk changes.

For any meaningful schema change:

- inspect existing content,
- assess compatibility with current queries/types,
- account for TypeGen,
- define migration/backfill when necessary,
- include rollback/recovery considerations,
- deploy and verify the Studio/schema through the correct workspace process.

Do not casually rename/remove populated fields without a migration plan.

---

## 14. Source-of-truth rule

This document describes stable modeling intent.

Once concrete schemas/types exist, the canonical implementation lives in:

- Sanity schema definitions,
- generated types,
- runtime validation schemas,
- migrations.

If this document and code disagree, do not silently guess. Identify the conflict in the implementation prompt.
