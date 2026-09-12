import {CONTEXT_SCHEMA_TYPE_NAME} from '@sanity/context/studio'
import {
  BookIcon,
  BulbOutlineIcon,
  CheckmarkCircleIcon,
  ClipboardIcon,
  PlayIcon,
  SearchIcon,
  TagIcon,
  UserIcon,
  VideoIcon,
} from '@sanity/icons'
import type {StructureBuilder, StructureResolver} from 'sanity/structure'

/**
 * Editorial review queues for generated assessments (development plan §5
 * PR-1). No list offers "create": assessments come only from the generator.
 */
const assessmentList = (S: StructureBuilder, title: string, filter: string) =>
  S.listItem()
    .title(title)
    .schemaType('assessment')
    .child(
      S.documentList()
        .title(title)
        .schemaType('assessment')
        .apiVersion('2026-08-31')
        .filter(`_type == "assessment" && ${filter}`)
        .initialValueTemplates([])
        .defaultOrdering([
          {field: 'familyId', direction: 'asc'},
          {field: 'version', direction: 'desc'},
        ]),
    )

/**
 * Review queues for generated concepts and prerequisite edges (development
 * plan §5 PR-3). Like assessments, neither offers "create".
 */
const reviewList = (
  S: StructureBuilder,
  schemaType: string,
  title: string,
  filter: string,
  ordering: Array<{field: string; direction: 'asc' | 'desc'}>,
) =>
  S.listItem()
    .title(title)
    .schemaType(schemaType)
    .child(
      S.documentList()
        .title(title)
        .schemaType(schemaType)
        .apiVersion('2026-08-31')
        .filter(`_type == "${schemaType}" && ${filter}`)
        .initialValueTemplates([])
        .defaultOrdering(ordering),
    )

const BY_NAME = [{field: 'name', direction: 'asc' as const}]
const BY_GENERATED = [{field: 'generation.generatedAt', direction: 'desc' as const}]

export const structure: StructureResolver = (S) =>
  S.list()
    .title('Vertex')
    .items([
      S.documentTypeListItem('course').title('Courses').icon(BookIcon),
      S.documentTypeListItem('lesson').title('Lessons').icon(PlayIcon),
      S.documentTypeListItem('instructor').title('Instructors').icon(UserIcon),
      S.documentTypeListItem('category').title('Categories').icon(TagIcon),
      S.divider(),
      S.listItem()
        .title('Assessments')
        .icon(ClipboardIcon)
        .child(
          S.list()
            .title('Assessments')
            .items([
              assessmentList(S, 'Needs review', 'reviewStatus == "needs_review" && sourceStatus != "stale"'),
              assessmentList(S, 'Approved', 'reviewStatus == "approved" && sourceStatus != "stale"'),
              assessmentList(S, 'Stale (source changed)', 'sourceStatus == "stale"'),
              assessmentList(S, 'Rejected or archived', 'reviewStatus in ["rejected", "archived"]'),
              S.divider(),
              assessmentList(S, 'All assessments', 'true'),
              S.listItem()
                .title('Generation records')
                .schemaType('assessmentGenerationRecord')
                .child(
                  S.documentTypeList('assessmentGenerationRecord')
                    .title('Generation records')
                    .initialValueTemplates([])
                    .defaultOrdering([{field: 'processedAt', direction: 'desc'}]),
                ),
            ]),
        ),
      S.listItem()
        .title('Concepts')
        .icon(BulbOutlineIcon)
        .child(
          S.list()
            .title('Concepts')
            .items([
              reviewList(S, 'concept', 'Needs review', 'reviewStatus == "needs_review" && sourceStatus != "stale"', BY_NAME),
              reviewList(S, 'concept', 'Approved', 'reviewStatus == "approved" && sourceStatus != "stale"', BY_NAME),
              reviewList(S, 'concept', 'Stale (source changed)', 'sourceStatus == "stale"', BY_NAME),
              reviewList(S, 'concept', 'Merged, split, or archived', 'reviewStatus in ["merged", "split", "archived"]', BY_NAME),
              reviewList(S, 'concept', 'Rejected', 'reviewStatus == "rejected"', BY_NAME),
              S.divider(),
              reviewList(S, 'conceptPrerequisite', 'Proposed prerequisites', 'status == "proposed" && sourceStatus != "stale"', BY_GENERATED),
              reviewList(S, 'conceptPrerequisite', 'Approved prerequisites', 'status == "approved" && sourceStatus != "stale"', BY_GENERATED),
              reviewList(S, 'conceptPrerequisite', 'Stale prerequisites', 'sourceStatus == "stale"', BY_GENERATED),
              reviewList(S, 'conceptPrerequisite', 'Rejected or retired prerequisites', 'status in ["rejected", "retired"]', BY_GENERATED),
              S.divider(),
              reviewList(S, 'conceptMergeProposal', 'Merge proposals to review', 'status == "proposed"', BY_GENERATED),
              reviewList(S, 'conceptMergeProposal', 'Accepted or rejected merges', 'status in ["accepted", "rejected"]', BY_GENERATED),
              S.divider(),
              S.listItem()
                .title('Generation records')
                .schemaType('conceptGenerationRecord')
                .child(
                  S.documentTypeList('conceptGenerationRecord')
                    .title('Concept generation records')
                    .initialValueTemplates([])
                    .defaultOrdering([{field: 'processedAt', direction: 'desc'}]),
                ),
            ]),
        ),
      S.divider(),
      S.documentTypeListItem('video').title('Video Intelligence').icon(VideoIcon),
      S.documentTypeListItem('progress').title('Learner progress').icon(CheckmarkCircleIcon),
      S.divider(),
      S.documentTypeListItem(CONTEXT_SCHEMA_TYPE_NAME).title('Search context').icon(SearchIcon),
    ])
