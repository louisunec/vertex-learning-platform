/**
 * The GROQ reads behind one lesson's assessment generation (development plan
 * §5 PR-1), shared by `npm run generate:assessments` and signal-driven
 * regeneration (PR-10) so both plan from exactly the same inputs.
 */

/** The lesson's video document: chapters and transcript chunks (published perspective). */
export const GENERATION_VIDEO_QUERY =
  '*[_id == $id][0]{_id, durationSeconds, chapters[]{startSeconds, label}, transcriptChunks[]{_key, startSeconds, text}}'

/** Every version of the lesson's assessments, drafts included (raw perspective). */
export const GENERATION_EXISTING_VERSIONS_QUERY =
  '*[_type == "assessment" && lesson._ref == $lessonId]{_id, familyId, version, sourceStatus, "spanKey": generation.spanKey, sourceChunkRefs[]{chunkId, chunkRevision}}'

/** Generation keys already recorded for the lesson (raw perspective). */
export const GENERATION_RECORDED_KEYS_QUERY = '*[_type == "assessmentGenerationRecord" && lesson._ref == $lessonId].spanKey'
