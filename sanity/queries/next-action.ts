import {defineQuery} from 'next-sanity'

/**
 * Published content for the next-action planner (PR-11). Learner-read rules
 * throughout (DATA_MODEL §16): published perspective (the server client),
 * with draft and release ids excluded explicitly; concepts and edges only
 * when approved and current. `$courseId` comes from the learner's stored
 * goal or a validated request id, and `$lessonIds` / `$conceptIds` from the
 * course itself, never from the browser. No answer key, hint, rubric, or
 * transcript text is selected.
 */

/** Published courses a learner can choose as a goal (browsing is public). */
export const GOAL_COURSES_QUERY = defineQuery(/* groq */ `
  *[
    _type == "course" &&
    defined(slug.current) &&
    !(_id in path("drafts.**")) &&
    !(_id in path("versions.**"))
  ] | order(title asc)[0...100] {
    _id,
    title,
    "slug": slug.current
  }
`)

/**
 * One published course with its ordered lessons. An unpublished lesson
 * dereferences to null in the published perspective and is dropped by the
 * caller; module and lesson numbers are derived from order, never stored.
 */
export const NEXT_ACTION_COURSE_QUERY = defineQuery(/* groq */ `
  *[
    _type == "course" &&
    _id == $courseId &&
    defined(slug.current) &&
    !(_id in path("drafts.**")) &&
    !(_id in path("versions.**"))
  ][0] {
    _id,
    title,
    "slug": slug.current,
    summary,
    modules[] {
      _key,
      lessons[]->{ _id, title, "slug": slug.current, durationSeconds }
    }
  }
`)

/**
 * The servable concepts taught in the course's lessons, with each concept's
 * cited chunks in those lessons (ids and times only, to build a source span).
 */
export const NEXT_ACTION_CONCEPTS_QUERY = defineQuery(/* groq */ `
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
    "sources": sourceRefs[lesson._ref in $lessonIds][0...40] {
      chunkId,
      "lessonId": lesson._ref,
      startSeconds,
      endSeconds
    }
  }
`)

/**
 * Published, approved, current prerequisite edges into the course's concepts
 * (`$conceptIds` are concept document ids). The prerequisite may be taught
 * elsewhere. The caller validates every edge before using it
 * (`lib/concepts/graph.ts`).
 */
export const NEXT_ACTION_EDGES_QUERY = defineQuery(/* groq */ `
  *[
    _type == "conceptPrerequisite" &&
    status == "approved" &&
    sourceStatus == "current" &&
    !(_id in path("drafts.**")) &&
    !(_id in path("versions.**")) &&
    dependent._ref in $conceptIds
  ] | order(_id asc)[0...300] {
    "id": _id,
    "prerequisite": prerequisite._ref,
    "dependent": dependent._ref,
    status
  }
`)

/**
 * SERVER-ONLY candidates for every lesson check in the course: the same
 * servable rules and projection as `LESSON_CHECK_CANDIDATES_QUERY` (PR-7),
 * for many lessons at once, so the planner can tell which lesson checks
 * would issue a question now. Only ids, families, concepts, and seconds are
 * used; parse with `toCheckCandidates` (`lib/assessments/learner.ts`).
 */
export const COURSE_CHECK_CANDIDATES_QUERY = defineQuery(/* groq */ `
  *[
    _type == "assessment" &&
    lesson._ref in $lessonIds &&
    reviewStatus == "approved" &&
    sourceStatus == "current" &&
    !(_id in path("drafts.**")) &&
    !(_id in path("versions.**")) &&
    lesson->_type == "lesson" &&
    count(*[
      _type == "assessment" &&
      familyId == ^.familyId &&
      version > ^.version &&
      reviewStatus == "approved" &&
      sourceStatus == "current" &&
      !(_id in path("drafts.**")) &&
      !(_id in path("versions.**"))
    ]) == 0
  ] | order(familyId asc, version desc)[0...300] {
    "item": {
      _id,
      _rev,
      familyId,
      version,
      "lessonId": lesson._ref,
      type,
      responseFormat,
      question,
      "options": options[] { "id": _key, text }
    },
    "primaryConceptRef": primaryConcept._ref,
    "firstSeconds": math::min(sourceChunkRefs[].startSeconds)
  }
`)
