import {CONTEXT_SCHEMA_TYPE_NAME} from '@sanity/context/studio'
import {
  BookIcon,
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
      S.divider(),
      S.documentTypeListItem('video').title('Video Intelligence').icon(VideoIcon),
      S.documentTypeListItem('progress').title('Learner progress').icon(CheckmarkCircleIcon),
      S.divider(),
      S.documentTypeListItem(CONTEXT_SCHEMA_TYPE_NAME).title('Search context').icon(SearchIcon),
    ])
