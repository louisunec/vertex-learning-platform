import type {SchemaTypeDefinition} from 'sanity'

import {assessment} from './documents/assessment'
import {assessmentGenerationRecord} from './documents/assessment-generation-record'
import {category} from './documents/category'
import {concept} from './documents/concept'
import {conceptGenerationRecord} from './documents/concept-generation-record'
import {conceptMergeProposal} from './documents/concept-merge-proposal'
import {conceptPrerequisite} from './documents/concept-prerequisite'
import {course} from './documents/course'
import {instructor} from './documents/instructor'
import {lesson} from './documents/lesson'
import {progress} from './documents/progress'
import {submissionTask} from './documents/submission-task'
import {video} from './documents/video'
import {blockContent} from './objects/block-content'
import {chapter} from './objects/chapter'
import {conceptSourceRef} from './objects/concept-source-ref'
import {learningOutcome} from './objects/learning-outcome'
import {module} from './objects/module'
import {resource} from './objects/resource'
import {transcriptChunk} from './objects/transcript-chunk'

export const schemaTypes: SchemaTypeDefinition[] = [
  // Documents
  course,
  lesson,
  instructor,
  category,
  video,
  progress,
  assessment,
  assessmentGenerationRecord,
  concept,
  conceptPrerequisite,
  conceptMergeProposal,
  conceptGenerationRecord,
  submissionTask,
  // Objects
  module,
  learningOutcome,
  resource,
  chapter,
  transcriptChunk,
  conceptSourceRef,
  blockContent,
]
