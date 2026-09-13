import postgres from 'postgres'

import {applyMigrations} from '../lib/db/migrate.ts'

/**
 * Applies pending learner-database migrations (development plan §5 PR-4).
 *
 *   npm run db:migrate
 *
 * Reads `DATABASE_URL` (the Supabase pooler URI) from `.env.local`. Forward
 * only and idempotent: a second run applies nothing.
 */

const url = process.env.DATABASE_URL?.trim()
if (!url) {
  console.error('DATABASE_URL is not set (see .env.example).')
  process.exit(1)
}

const sql = postgres(url, {max: 1, prepare: false, onnotice: () => {}})
try {
  const applied = await applyMigrations(sql, new URL('../db/migrations/', import.meta.url))
  console.log(applied.length > 0 ? `Applied ${applied.length} migration(s): ${applied.join(', ')}` : 'Up to date.')
} catch (error) {
  console.error('Migration failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  await sql.end()
}
