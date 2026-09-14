import {defineQuery} from 'next-sanity'

import {imageFragment} from './fragments.ts'

/**
 * My Learning reads. `$lessonIds` always comes from the signed-in learner's
 * own server-side records (progress rows, attempt log), never from the browser.
 */

/** Courses that contain any of the learner's lessons, with their ordered lessons. */
export const MY_LEARNING_COURSES_QUERY = defineQuery(/* groq */ `
  *[_type == "course" && defined(slug.current) && references($lessonIds)] | order(title asc) {
    _id,
    title,
    "slug": slug.current,
    summary,
    coverImage { ${imageFragment} },
    modules[] {
      _key,
      lessons[]->{ _id, title, "slug": slug.current }
    }
  }
`)

/** Titles and slugs for the lessons named in the recent-learning feed. */
export const LESSONS_BY_IDS_QUERY = defineQuery(/* groq */ `
  *[_type == "lesson" && _id in $lessonIds && defined(slug.current)] {
    _id,
    title,
    "slug": slug.current
  }
`)

/**
 * Stable ids of the servable concepts taught in the given lessons (DATA_MODEL
 * §16 learner-read rules: published, approved, current, no drafts or versions).
 */
export const CONCEPT_IDS_FOR_LESSONS_QUERY = defineQuery(/* groq */ `
  *[
    _type == "concept" &&
    reviewStatus == "approved" &&
    sourceStatus == "current" &&
    !(_id in path("drafts.**")) &&
    !(_id in path("versions.**")) &&
    count(lessons[@._ref in $lessonIds]) > 0
  ] | order(_id asc)[0...500].conceptId
`)

/**
 * Knowledge map nodes: the servable concepts taught in the course's lessons
 * (the same learner-read rules as above), with each concept's cited moments
 * in those lessons. `$lessonIds` is the course's own lesson list.
 */
export const KNOWLEDGE_MAP_CONCEPTS_QUERY = defineQuery(/* groq */ `
  *[
    _type == "concept" &&
    reviewStatus == "approved" &&
    sourceStatus == "current" &&
    !(_id in path("drafts.**")) &&
    !(_id in path("versions.**")) &&
    count(lessons[@._ref in $lessonIds]) > 0
  ] | order(_id asc)[0...100] {
    "id": _id,
    conceptId,
    name,
    summary,
    "sources": sourceRefs[lesson._ref in $lessonIds][0...20] {
      "lessonId": lesson._ref,
      startSeconds
    }
  }
`)

/**
 * Knowledge map edges: published, approved, current prerequisite edges
 * between concepts on the map (`$conceptIds` are concept document ids). The
 * caller still validates them before drawing (`lib/concepts/graph.ts`).
 */
export const KNOWLEDGE_MAP_EDGES_QUERY = defineQuery(/* groq */ `
  *[
    _type == "conceptPrerequisite" &&
    status == "approved" &&
    sourceStatus == "current" &&
    !(_id in path("drafts.**")) &&
    !(_id in path("versions.**")) &&
    prerequisite._ref in $conceptIds &&
    dependent._ref in $conceptIds
  ] | order(_id asc)[0...300] {
    "id": _id,
    "prerequisite": prerequisite._ref,
    "dependent": dependent._ref,
    status,
    rationale,
    "evidence": evidence[0...2] { "lessonId": lesson._ref, startSeconds }
  }
`)

/**
 * SERVER-ONLY, display only: AI-proposed prerequisite edges between concepts
 * on the map — generator drafts with status "proposed" that no editor has
 * reviewed (DATA_MODEL: only approved, published edges are the graph). Read
 * with the raw perspective, and only for viewers allowlisted by
 * `KNOWLEDGE_MAP_PROPOSED_EDGES_USER_IDS`. Never used for gating, mastery,
 * or next actions.
 */
export const KNOWLEDGE_MAP_PROPOSED_EDGES_QUERY = defineQuery(/* groq */ `
  *[
    _type == "conceptPrerequisite" &&
    _id in path("drafts.**") &&
    status == "proposed" &&
    sourceStatus == "current" &&
    prerequisite._ref in $conceptIds &&
    dependent._ref in $conceptIds
  ] | order(_id asc)[0...300] {
    "id": _id,
    "prerequisite": prerequisite._ref,
    "dependent": dependent._ref,
    rationale,
    "evidence": evidence[0...2] { "lessonId": lesson._ref, startSeconds }
  }
`)
