import {CONTEXT_SCHEMA_TYPE_NAME} from '@sanity/context/studio'
import {BookIcon, CheckmarkCircleIcon, PlayIcon, SearchIcon, TagIcon, UserIcon, VideoIcon} from '@sanity/icons'
import type {StructureResolver} from 'sanity/structure'

export const structure: StructureResolver = (S) =>
  S.list()
    .title('Vertex')
    .items([
      S.documentTypeListItem('course').title('Courses').icon(BookIcon),
      S.documentTypeListItem('lesson').title('Lessons').icon(PlayIcon),
      S.documentTypeListItem('instructor').title('Instructors').icon(UserIcon),
      S.documentTypeListItem('category').title('Categories').icon(TagIcon),
      S.divider(),
      S.documentTypeListItem('video').title('Video Intelligence').icon(VideoIcon),
      S.documentTypeListItem('progress').title('Learner progress').icon(CheckmarkCircleIcon),
      S.divider(),
      S.documentTypeListItem(CONTEXT_SCHEMA_TYPE_NAME).title('Search context').icon(SearchIcon),
    ])
