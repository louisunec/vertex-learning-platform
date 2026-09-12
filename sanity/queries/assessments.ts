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
