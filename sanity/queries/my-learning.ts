import {defineQuery} from 'next-sanity'

import {imageFragment} from './fragments'

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
