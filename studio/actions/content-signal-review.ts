import {CheckmarkIcon, EyeOpenIcon, ResetIcon, SearchIcon} from '@sanity/icons'
import type {ComponentType} from 'react'
import {useCurrentUser, useDocumentOperation, type DocumentActionComponent} from 'sanity'

/**
 * Review actions for editorial content signals (development plan §5
 * PR-10): Start investigating, Acknowledge, Resolve, and Reopen. Each sets
 * the review status and stamps when and by whom it changed. Signals are
 * `liveEdit`, so the change applies directly; the job that computes a
 * signal never writes these fields after creating it.
 */

type Status = 'open' | 'investigating' | 'acknowledged' | 'resolved'

function reviewAction(
  target: Status,
  label: string,
  from: ReadonlyArray<Status>,
  icon: ComponentType,
  tone?: 'positive' | 'caution',
): DocumentActionComponent {
  const Action: DocumentActionComponent = (props) => {
    const {patch} = useDocumentOperation(props.id, props.type)
    const user = useCurrentUser()
    const current = String((props.published ?? props.draft)?.reviewStatus ?? 'open') as Status
    if (!from.includes(current)) return null
    return {
      label,
      icon,
      tone,
      onHandle: () => {
        patch.execute([{set: {reviewStatus: target, reviewedAt: new Date().toISOString(), reviewedBy: user?.id ?? 'unknown'}}])
        props.onComplete()
      },
    }
  }
  Action.displayName = `SignalReview_${target}`
  return Action
}

export const SIGNAL_REVIEW_ACTIONS: DocumentActionComponent[] = [
  reviewAction('investigating', 'Start investigating', ['open'], SearchIcon),
  reviewAction('acknowledged', 'Acknowledge', ['open', 'investigating'], EyeOpenIcon),
  reviewAction('resolved', 'Resolve', ['open', 'investigating', 'acknowledged'], CheckmarkIcon, 'positive'),
  reviewAction('open', 'Reopen', ['acknowledged', 'resolved'], ResetIcon, 'caution'),
]
