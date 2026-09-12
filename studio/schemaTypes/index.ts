import type {SchemaTypeDefinition} from 'sanity'

import {assessment} from './documents/assessment'
import {assessmentGenerationRecord} from './documents/assessment-generation-record'
import {category} from './documents/category'
import {course} from './documents/course'
import {instructor} from './documents/instructor'
import {lesson} from './documents/lesson'
import {progress} from './documents/progress'
import {video} from './documents/video'
import {blockContent} from './objects/block-content'
import {chapter} from './objects/chapter'
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
  // Objects
  module,
  learningOutcome,
  resource,
  chapter,
  transcriptChunk,
  blockContent,
]
