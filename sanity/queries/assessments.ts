import {defineQuery} from 'next-sanity'

/**
 * Learner-safe practice items for one lesson (development plan §5 PR-1).
 * Explicit fields only: the answer key, hints, source excerpt, and generation
 * metadata are never selected. Parse rows with `toLearnerAssessments`
 * (`lib/assessments/learner.ts`), whose strict schema drops anything more.
 * Published perspective (the server client), with draft and release ids
 * excluded explicitly as well. Approved, current items only, one per family
 * (its latest servable version) before the per-lesson bound, so older
 * versions never crowd families out of it.
 */
export const LESSON_PRACTICE_ITEMS_QUERY = defineQuery(/* groq */ `
  *[
    _type == "assessment" &&
    lesson._ref == $lessonId &&
    reviewStatus == "approved" &&
    sourceStatus == "current" &&
    !(_id in path("drafts.**")) &&
    !(_id in path("versions.**")) &&
    count(*[
      _type == "assessment" &&
      familyId == ^.familyId &&
      version > ^.version &&
      reviewStatus == "approved" &&
      sourceStatus == "current" &&
      !(_id in path("drafts.**")) &&
      !(_id in path("versions.**"))
    ]) == 0
  ] | order(familyId asc, version desc)[0...50] {
    _id,
    _rev,
    familyId,
    version,
    "lessonId": lesson._ref,
    type,
    responseFormat,
    question,
    "options": options[] { "id": _key, text }
  }
`)

/**
 * One learner-safe item to issue as a task instance (development plan §5
 * PR-4): the same projection and servable rules as the lesson query, only
 * the latest servable version of its family, and only while its lesson is
 * published. Parse with `toLearnerAssessments`.
 */
export const SERVABLE_ASSESSMENT_QUERY = defineQuery(/* groq */ `
  *[
    _type == "assessment" &&
    _id == $assessmentId &&
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
  ][0] {
    _id,
    _rev,
    familyId,
    version,
    "lessonId": lesson._ref,
    type,
    responseFormat,
    question,
    "options": options[] { "id": _key, text }
  }
`)

/**
 * SERVER-ONLY grading row for one delivered version (development plan §5
 * PR-4). Selects the correct option id, so its result must never reach a
 * response: parse with `toGradingItem` (`lib/assessments/grading.ts`) and
 * return only the grade. A delivered version stays gradable while it is
 * approved and current, even after a newer version is published; a stale or
 * withdrawn one is not graded.
 */
export const GRADING_ASSESSMENT_QUERY = defineQuery(/* groq */ `
  *[
    _type == "assessment" &&
    _id == $assessmentId &&
    reviewStatus == "approved" &&
    sourceStatus == "current" &&
    !(_id in path("drafts.**")) &&
    !(_id in path("versions.**")) &&
    lesson->_type == "lesson"
  ][0] {
    _id,
    familyId,
    version,
    "lessonId": lesson._ref,
    "optionIds": options[]._key,
    "correctOptionId": answerKey.correctOptionId,
    "primaryConceptRef": primaryConcept._ref
  }
`)

/**
 * Published concept nodes for resolving an item's primary concept through
 * merges and splits (`lib/concepts/resolve.ts`). Ids and statuses only.
 * Bounded; a concept beyond the bound resolves as missing, which skips the
 * projection rather than guessing.
 */
export const CONCEPT_NODES_QUERY = defineQuery(/* groq */ `
  *[
    _type == "concept" &&
    !(_id in path("drafts.**")) &&
    !(_id in path("versions.**"))
  ] | order(_id asc)[0...2000] {
    "id": _id,
    conceptId,
    reviewStatus,
    "mergedInto": mergedInto._ref,
    "splitInto": splitInto[]._ref
  }
`)
