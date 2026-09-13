import 'server-only'

import postgres from 'postgres'

import {DatabaseUnavailableError} from './errors.ts'

/**
 * Server-only Postgres client for learner evidence (Supabase). `DATABASE_URL`
 * is the Supabase pooler URI; it never reaches the browser. Transaction-mode
 * pooling does not keep prepared statements, hence `prepare: false`.
 */

let db: postgres.Sql | null = null

export function getDb(): postgres.Sql {
  const url = process.env.DATABASE_URL?.trim()
  if (!url) throw new DatabaseUnavailableError('DATABASE_URL is not set')
  db ??= postgres(url, {
    max: 5,
    prepare: false,
    connect_timeout: 5,
    idle_timeout: 20,
    onnotice: () => {},
    connection: {application_name: 'vertex-web'},
  })
  return db
}
