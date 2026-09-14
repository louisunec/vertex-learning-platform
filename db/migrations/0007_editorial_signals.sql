-- PR-10: outbox delivery and editorial learning signals (development plan
-- §5 PR-10). Depends only on 0001 and 0002.
--
-- Background workers (the outbox dispatcher and the signal aggregator,
-- `npm run outbox` / `npm run signals`) run every query as
-- `vertex_signals_worker` (`SET LOCAL ROLE` per transaction, see
-- `lib/db/worker-scope.ts`), a role that cannot bypass row level security
-- and reaches only the rows and columns granted below. It never deletes.
--
-- Additive only: rollback stops the jobs and keeps every row.

-- Outbox delivery. A worker claims a row with a lease (`claimed_by`,
-- `claimed_until`); an expired lease makes it claimable again, so a crashed
-- worker's rows are recovered. `failed` is the dead-letter state after the
-- attempt cap; `suppressed` marks events from labelled synthetic learners,
-- which are never sent.
alter table learner.event_outbox
  add column claimed_by text check (char_length(claimed_by) <= 128),
  add column claimed_until timestamptz,
  add column delivered_at timestamptz;
alter table learner.event_outbox drop constraint event_outbox_status_check;
alter table learner.event_outbox
  add constraint event_outbox_status_check check (status in ('pending', 'delivered', 'failed', 'suppressed'));

-- The tutor's playhead when a question was asked, so editors can see where
-- insufficient-evidence questions cluster. Null for rows written before PR-10.
alter table learner.tutor_request
  add column current_seconds integer check (current_seconds >= 0);

-- Clerk ids of demo, test, and other synthetic accounts. Their activity is
-- excluded from every editorial aggregate and never delivered to analytics.
create table learner.synthetic_learner (
  learner_id text primary key check (char_length(learner_id) between 1 and 128),
  label text not null check (label in ('synthetic', 'test', 'demo', 'staff')),
  note text check (char_length(note) <= 200),
  created_at timestamptz not null default now()
);
alter table learner.synthetic_learner enable row level security;

-- Operational state of the editorial jobs. Not learner data.
create schema if not exists editorial;

-- One row per job run: the checkpoint and the operational log.
create table editorial.job_run (
  id uuid primary key default gen_random_uuid(),
  job text not null check (job in ('outbox_dispatch', 'signal_aggregation', 'regeneration')),
  worker text not null check (char_length(worker) <= 128),
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  window_start timestamptz,
  window_end timestamptz,
  counts jsonb not null default '{}',
  error text check (char_length(error) <= 500),
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index job_run_job_started_idx on editorial.job_run (job, started_at desc);

-- Draft regeneration candidates queued by signals. At most one per source
-- revision (the assessment's generation span key) per UTC day.
create table editorial.regeneration_candidate (
  id uuid primary key default gen_random_uuid(),
  source_key text not null check (char_length(source_key) between 1 and 200),
  queued_day date not null,
  signal_id text not null check (char_length(signal_id) <= 200),
  lesson_id text not null,
  family_id text not null,
  assessment_id text not null,
  assessment_version integer not null check (assessment_version >= 1),
  status text not null default 'queued' check (status in ('queued', 'running', 'drafted', 'skipped', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  claimed_by text check (char_length(claimed_by) <= 128),
  claimed_until timestamptz,
  result jsonb not null default '{}',
  last_error text check (char_length(last_error) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_key, queued_day)
);
create index regeneration_candidate_status_idx on editorial.regeneration_candidate (status, created_at);

alter table editorial.job_run enable row level security;
alter table editorial.regeneration_candidate enable row level security;

-- The workers' identity. Roles are cluster-wide, so an existing role is
-- reused, but never one that could bypass row level security.
do $$
begin
  create role vertex_signals_worker nologin;
exception when duplicate_object or unique_violation then null;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'vertex_signals_worker' and (rolsuper or rolbypassrls)) then
    raise exception 'vertex_signals_worker must not be a superuser or bypass row level security';
  end if;
  if current_setting('server_version_num')::int >= 160000 then
    execute format('grant vertex_signals_worker to %I with set true, inherit false', current_user);
  else
    execute format('grant vertex_signals_worker to %I', current_user);
  end if;
end
$$;

-- Least privilege: read the signal sources, update only the outbox's
-- delivery columns, and keep the job tables. No DELETE anywhere.
grant usage on schema learner, editorial to vertex_signals_worker;
grant select on learner.attempt_log, learner.tutor_request to vertex_signals_worker;
grant select, insert on learner.synthetic_learner to vertex_signals_worker;
grant select on learner.event_outbox to vertex_signals_worker;
grant update (status, attempts, next_attempt_at, last_error, claimed_by, claimed_until, delivered_at)
  on learner.event_outbox to vertex_signals_worker;
grant select, insert, update on editorial.job_run, editorial.regeneration_candidate to vertex_signals_worker;

create policy signals_worker_read on learner.attempt_log for select to vertex_signals_worker using (true);
create policy signals_worker_read on learner.tutor_request for select to vertex_signals_worker using (true);
create policy signals_worker_all on learner.synthetic_learner for all to vertex_signals_worker using (true) with check (true);
create policy signals_worker_read on learner.event_outbox for select to vertex_signals_worker using (true);
create policy signals_worker_deliver on learner.event_outbox for update to vertex_signals_worker using (true) with check (true);
create policy signals_worker_all on editorial.job_run for all to vertex_signals_worker using (true) with check (true);
create policy signals_worker_all on editorial.regeneration_candidate for all to vertex_signals_worker using (true) with check (true);

-- Supabase's Data API roles, as in 0001. Absent on a plain Postgres.
do $$
declare
  api_role text;
begin
  foreach api_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = api_role) then
      execute format('revoke all on schema editorial from %I', api_role);
      execute format('revoke all on all tables in schema editorial from %I', api_role);
      execute format('alter default privileges in schema editorial revoke all on tables from %I', api_role);
      execute format('revoke all on learner.synthetic_learner from %I', api_role);
    end if;
  end loop;
end
$$;
