import {randomUUID} from 'node:crypto'

import postgres from 'postgres'

import {applyMigrations} from './migrate.ts'

/**
 * Disposable databases for the database tests. `TEST_DATABASE_URL` points at
 * a throwaway Postgres (never Supabase); each test file creates its own
 * database there, so files running in parallel never share state. Without
 * the variable those suites are skipped and reported as such.
 */

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL?.trim() || undefined

export const SKIP_WITHOUT_DATABASE = TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL is not set'

export const MIGRATIONS_DIR = new URL('../../db/migrations/', import.meta.url)

export type TestDatabase = {sql: postgres.Sql; url: string; drop(): Promise<void>}

/**
 * Roles are cluster-wide, and test files migrate their databases in
 * parallel. Creating the app role (and Supabase's Data API roles, so the
 * migration's revoke path runs) up front, with retries, keeps concurrent
 * migrations from racing on role creation and membership (the learner app
 * role from 0001, the worker role from 0007).
 */
async function ensureClusterRoles(admin: postgres.Sql): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await admin.unsafe(`
        do $$
        declare
          name text;
        begin
          foreach name in array array['vertex_learner_app', 'vertex_signals_worker', 'anon', 'authenticated'] loop
            begin
              execute format('create role %I nologin', name);
            exception when duplicate_object or unique_violation then null;
            end;
          end loop;
          if current_setting('server_version_num')::int >= 160000 then
            execute format('grant vertex_learner_app to %I with set true, inherit false', current_user);
            execute format('grant vertex_signals_worker to %I with set true, inherit false', current_user);
          else
            execute format('grant vertex_learner_app to %I', current_user);
            execute format('grant vertex_signals_worker to %I', current_user);
          end if;
        end
        $$;
      `).simple()
      return
    } catch (error) {
      if (attempt >= 5) throw error
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt))
    }
  }
}

export async function createTestDatabase({migrate = true}: {migrate?: boolean} = {}): Promise<TestDatabase> {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not set')
  const admin = postgres(TEST_DATABASE_URL, {max: 1, onnotice: () => {}})
  await ensureClusterRoles(admin)
  const name = `vertex_test_${randomUUID().replaceAll('-', '')}`
  await admin.unsafe(`create database ${name}`)

  const url = new URL(TEST_DATABASE_URL)
  url.pathname = `/${name}`
  // Mirrors the app client: no prepared statements (Supabase transaction pooler).
  const sql = postgres(url.toString(), {max: 10, prepare: false, onnotice: () => {}})
  if (migrate) await applyMigrations(sql, MIGRATIONS_DIR)

  return {
    sql,
    url: url.toString(),
    async drop() {
      await sql.end()
      await admin.unsafe(`drop database if exists ${name} with (force)`)
      await admin.end()
    },
  }
}
