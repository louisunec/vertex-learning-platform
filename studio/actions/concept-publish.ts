import type {DocumentActionComponent, SanityDocument} from 'sanity'

import {
  CONCEPT_CONTENT_FIELDS,
  CONCEPT_REVIEW_CHECKS,
  CONCEPT_TOMBSTONE_STATUSES,
} from '../schemaTypes/documents/concept'
import {PREREQUISITE_REVIEW_CHECKS} from '../schemaTypes/documents/concept-prerequisite'
import {contentChanged} from './assessment-publish'

/**
 * Editorial gates on publishing concepts and prerequisite edges (development
 * plan §5 PR-3). Nothing the generator drafts reaches the published
 * perspective without an editor ticking every review check here.
 */

type Ref = {_ref?: string} | undefined

const refOf = (value: unknown) => (value as Ref)?._ref ?? null
const publishedId = (id: string) => id.replace(/^drafts\./, '')
const allChecked = (document: SanityDocument, checks: ReadonlyArray<{name: string}>) => {
  const review = (document.review ?? {}) as Record<string, unknown>
  return checks.every((check) => review[check.name] === true)
}

/**
 * A concept publishes when approved with every check, or as a tombstone
 * (merged, split, archived) with valid successors and unchanged content. Its
 * id never changes, and its revision increases by exactly one when published
 * content changes — and only then.
 */
export function conceptPublishBlockReason(draft: SanityDocument | null, published: SanityDocument | null): string | null {
  if (!draft) return null
  if (published && draft.conceptId !== published.conceptId) return 'A concept keeps its id. Create a new concept instead.'

  const changed = published ? contentChanged(draft, published, CONCEPT_CONTENT_FIELDS) : false
  const publishedRevision = Number(published?.revision ?? 1)
  if (!published && draft.revision !== 1) return 'A new concept starts at revision 1.'
  if (published && changed && draft.revision !== publishedRevision + 1) {
    return `Content changed since revision ${publishedRevision}: set the revision to ${publishedRevision + 1}.`
  }
  if (published && !changed && draft.revision !== publishedRevision) {
    return `Keep revision ${publishedRevision}: only a content change increases it.`
  }

  const status = String(draft.reviewStatus ?? '')
  if ((CONCEPT_TOMBSTONE_STATUSES as readonly string[]).includes(status)) {
    if (changed) return 'A merged, split, or archived concept keeps its published content.'
    const self = publishedId(draft._id)
    if (status === 'merged') {
      const target = refOf(draft.mergedInto)
      return target && target !== self ? null : 'Choose the concept this one was merged into.'
    }
    if (status === 'split') {
      const targets = ((draft.splitInto as Ref[] | undefined) ?? []).map(refOf)
      const valid = targets.length >= 2 && new Set(targets).size === targets.length && targets.every((target) => target && target !== self)
      return valid ? null : 'Choose at least two other concepts this one was split into.'
    }
    return null
  }
  if (status !== 'approved') return 'Set the review status to Approved (or merge, split, or archive the concept) before publishing.'
  return allChecked(draft, CONCEPT_REVIEW_CHECKS) ? null : 'Complete every review check before publishing.'
}

/**
 * Discarding a never-published generator draft would delete it, and a
 * rejected one is kept for audit and suppression. Editors reject it instead;
 * discarding edits to a published document still works.
 */
export function keepUnpublishedDrafts(discard: DocumentActionComponent): DocumentActionComponent {
  const KeepUnpublishedDrafts: DocumentActionComponent = (props) => {
    const description = discard(props)
    return description && !props.published
      ? {...description, disabled: true, title: 'Generated drafts are kept for audit: set the status to Rejected instead.'}
      : description
  }
  KeepUnpublishedDrafts.action = discard.action
  KeepUnpublishedDrafts.displayName = 'KeepUnpublishedDraftsAction'
  return KeepUnpublishedDrafts
}

/** An edge publishes when approved with every check, or when retired. Its endpoints never change once published. */
export function prerequisitePublishBlockReason(draft: SanityDocument | null, published: SanityDocument | null): string | null {
  if (!draft) return null
  const [from, to] = [refOf(draft.prerequisite), refOf(draft.dependent)]
  if (published && (from !== refOf(published.prerequisite) || to !== refOf(published.dependent))) {
    return 'A published edge keeps its endpoints. Retire it instead.'
  }
  if (from && from === to) return 'A concept cannot be its own prerequisite.'
  if (draft.status === 'retired') return null
  if (draft.status !== 'approved') return 'Set the status to Approved before publishing.'
  return allChecked(draft, PREREQUISITE_REVIEW_CHECKS) ? null : 'Complete every review check before publishing.'
}
