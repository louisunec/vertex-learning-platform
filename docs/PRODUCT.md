# Vertex Product Specification

## 1. Product purpose

Vertex is a production-style learning platform where authors create structured courses and learners browse, study, resume progress, and search learning content with natural language.

Its differentiating experience is grounded search:

- a learner enters a plain-language query,
- Vertex finds relevant lessons and exact moments inside lesson videos,
- results are ranked and shown as structured cards,
- video results open the lesson at the matched second,
- playback remains inside Vertex through the video provider's embed.

Vertex is a learning product with search, **not a general-purpose AI chat product**.

---

## 2. Product surfaces

The product includes:

- course catalog,
- course detail pages,
- lesson pages,
- instructor pages,
- My Learning,
- authentication and learner accounts,
- learner progress and resume state,
- product analytics,
- content search results,
- offline transcript/chapter ingestion,
- Sanity authoring for the content model and search configuration.

Do not create unrelated product surfaces unless explicitly requested.

---

## 3. Course catalog

The catalog presents available courses using stored Sanity content.

It may surface:

- title,
- summary,
- cover image,
- instructor,
- category,
- level,
- price,
- popularity or student-count display fields,
- learner completion/resume state when available.

Browsing remains public unless a specific feature is explicitly protected.

The catalog does not independently invent merchandising data or AI-generated course metadata.

---

## 4. Course detail

A course page presents the stored course, its instructor, learning outcomes, and ordered curriculum.

Modules and lessons are shown in authored order.

Displayed numbering such as:

- `Module 5`
- `Lesson 5.1`

is derived from list order and is not stored as canonical content.

Where learner state exists, the page may show completion and resume affordances.

---

## 5. Lesson page

A lesson page contains:

- provider-hosted embedded video,
- lesson title and metadata,
- lesson notes,
- key points,
- optional pro tip,
- resources,
- instructor/course context,
- learner progress state.

Video playback remains on-site.

A search result may link to the lesson with a start-time parameter. The lesson page translates that into the provider's supported seek/start behavior.

Do not build a custom video player unless the product decision is explicitly changed.

---

## 6. Search experience

Search is a **full results page**.

It is not:

- a chatbox,
- a compact assistant widget,
- an LLM-generated list of only a few favorite answers.

The page shows grounded results ordered by relevance.

Two user-facing result types exist:

### Video moment

A video result represents a relevant moment inside a lesson's video.

It should provide enough stored/derived information to render the design, including:

- course identity,
- module/lesson context,
- thumbnail/poster,
- relevant description,
- matched start second,
- clip/duration information when available.

Its primary action opens the lesson and begins playback from the matched second.

### Lesson

A lesson result represents a lesson whose topic/content matches the query.

It may include:

- course identity,
- module/lesson context,
- lesson key points,
- relevant description.

Its primary action opens the lesson.

A video document itself is never displayed as a standalone result.

---

## 7. Search result volume

Vertex should not artificially reduce search to a small LLM-selected shortlist.

At the same time, the browser must not receive an unbounded result payload.

Product behavior should therefore support:

- ranked result counts when grounded,
- a bounded initial page,
- pagination or progressive loading,
- access to further relevant results.

The exact page size is an implementation decision unless the design specifies it.

---

## 8. Learner progress

Progress is per authenticated learner.

It tracks at least:

- completed lessons,
- the last/resume position within a lesson.

Progress can be surfaced as:

- completion marks,
- continue/resume affordances,
- My Learning content.

Progress is user state, not authored learning content.

The browser never writes progress directly to Sanity or another protected datastore.

---

## 9. My Learning and presentational surfaces

Unless explicitly expanded:

- **My Learning** reads existing learner progress and presents it.
- **Notifications** are presentational; there is no separate notification backend.
- **Lesson Notes tab** is a presentation of stored lesson notes, not a separate note-taking system.
- **Free preview** is a display label, not access-control logic.

Do not infer new backends from visual UI elements alone.

---

## 10. Authentication behavior

Clerk is the authentication system.

Do not:

- replace it with Sanity auth,
- roll a custom auth system,
- require authentication for public browsing unless a feature explicitly needs it.

Per-user learner state keys off the Clerk user id.

---

## 11. Product analytics

PostHog captures meaningful learner engagement.

Core events include the moments represented by:

- catalog/course/lesson viewing,
- search performed,
- video play,
- meaningful video progress/watch depth,
- lesson completion.

Use the existing project's event naming/payload conventions once established.

Analytics instrumentation must not redefine product behavior or become a second source of business state.

---

## 12. UI fidelity

When the user provides reference images:

- desktop reference images are the visual source of truth,
- reproduce layout, spacing, typography, color, and states,
- do not redesign or "improve" the UI unless asked,
- make sensible responsive adaptations for smaller screens where no mobile reference exists.

Product docs define behavior; reference images define appearance.

---

## 13. Grounding rules

Anything presented as real product/content data must come from the system's stored data or deterministic derivation from it.

Never invent:

- course names,
- lesson names,
- instructors,
- prices,
- durations,
- timestamps,
- student counts,
- search result counts,
- video matches.

If no grounded result fits a search, show an empty state and guide the learner toward the catalog rather than fabricating an answer.

---

## 14. Out of scope by default

Unless explicitly requested, do not add:

- a conversational AI tutor,
- custom video hosting/player infrastructure,
- learner-generated notes backend,
- recommendation systems unrelated to search,
- billing/e-commerce infrastructure beyond existing display requirements,
- social/community features,
- notification delivery systems,
- extra admin systems outside Sanity Studio,
- a separate backend framework.

When uncertain, prefer the smaller product.
