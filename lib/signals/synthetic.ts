import type postgres from 'postgres'

import {asSignalsWorker} from '../db/worker-scope.ts'

/**
 * Labelled synthetic learners (`learner.synthetic_learner`, migration 0007):
 * demo, test, and staff accounts whose activity is excluded from every
 * editorial aggregate and never delivered to analytics. Labels are added
 * with `npm run signals -- synthetic add`; removing one is a deliberate
 * manual SQL step, because it changes past aggregates on the next rerun.
 */

export const SYNTHETIC_LABELS = ['synthetic', 'test', 'demo', 'staff'] as const
export type SyntheticLabel = (typeof SYNTHETIC_LABELS)[number]

const CLERK_ID = /^[A-Za-z0-9_-]{1,128}$/

export type SyntheticLearner = {learnerId: string; label: SyntheticLabel; note: string | null; createdAt: Date}

export async function listSyntheticLearners(db: postgres.Sql): Promise<SyntheticLearner[]> {
  return asSignalsWorker(
    db,
    (tx) => tx<SyntheticLearner[]>`
      select learner_id as "learnerId", label, note, created_at as "createdAt" from learner.synthetic_learner order by created_at
    `,
  )
}

/** Labels a learner as synthetic; returns false when it already was. */
export async function addSyntheticLearner(
  db: postgres.Sql,
  {learnerId, label, note = null}: {learnerId: string; label: SyntheticLabel; note?: string | null},
): Promise<boolean> {
  if (!CLERK_ID.test(learnerId)) throw new RangeError('Not a Clerk user id')
  if (!SYNTHETIC_LABELS.includes(label)) throw new RangeError(`Label must be one of ${SYNTHETIC_LABELS.join(', ')}`)
  const rows = await asSignalsWorker(
    db,
    (tx) => tx`
      insert into learner.synthetic_learner (learner_id, label, note) values (${learnerId}, ${label}, ${note?.slice(0, 200) ?? null})
      on conflict (learner_id) do nothing
      returning learner_id
    `,
  )
  return rows.length > 0
}
