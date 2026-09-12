import type {DocumentActionComponent, SanityDocument} from 'sanity'

import {ASSESSMENT_CONTENT_FIELDS, REVIEW_CHECKS} from '../schemaTypes/documents/assessment'

/**
 * Editorial gate on publishing assessments (development plan §5 PR-1):
 * a draft publishes only when approved with every review check ticked, or
 * when archiving. Published versions are immutable, archived ones included:
 * a draft that changes their content cannot publish — status-only changes can.
 */
export function publishBlockReason(draft: SanityDocument | null, published: SanityDocument | null): string | null {
  if (!draft) return null
  if (published && contentChanged(draft, published)) {
    return 'Published versions are immutable. Generate or author a new version instead.'
  }
  if (draft.reviewStatus === 'archived') return null
  if (draft.reviewStatus !== 'approved') return 'Set the review status to Approved before publishing.'
  const review = (draft.review ?? {}) as Record<string, unknown>
  if (!REVIEW_CHECKS.every((check) => review[check.name] === true)) {
    return 'Complete every review check before publishing.'
  }
  return null
}

function contentChanged(a: SanityDocument, b: SanityDocument): boolean {
  return ASSESSMENT_CONTENT_FIELDS.some((field) => stableStringify(a[field]) !== stableStringify(b[field]))
}

/** JSON with sorted object keys, so key order never reads as a content change. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/** Wraps the built-in publish action; the original still runs so its hooks stay stable. */
export function gatePublish(publish: DocumentActionComponent): DocumentActionComponent {
  const GatedPublish: DocumentActionComponent = (props) => {
    const description = publish(props)
    const reason = publishBlockReason(props.draft, props.published)
    return description && reason ? {...description, disabled: true, title: reason} : description
  }
  GatedPublish.action = publish.action
  GatedPublish.displayName = 'GatedAssessmentPublishAction'
  return GatedPublish
}
