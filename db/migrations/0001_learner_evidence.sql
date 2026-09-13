-- PR-4: private learner evidence (development plan §5 PR-4).
--
-- Everything lives in the `learner` schema, which Supabase's Data API does
-- not expose, and the Data API roles lose every privilege, so a leaked anon
-- key reads nothing.
--
-- The web server connects with DATABASE_URL but runs every learner query as
-- `vertex_learner_app` (`SET LOCAL ROLE` in each transaction, see
-- `lib/db/learner-scope.ts`) with `app.learner_id` set to the Clerk user id.
-- That role cannot bypass row level security, so the database itself
-- confines each transaction to one learner's rows; the route handlers'
-- authorization checks stay in place as well.
--
-- `learner_id` is the Clerk user id resolved by `auth()` on the server.
-- Sanity ids (`assessment_id`, `lesson_id`, `concept_id`) are
-- application-validated external ids, not foreign keys. Additive only:
-- rollback disables the routes and keeps every row.

create schema if not exists learner;

-- One server-issued delivery of one assessment version to one learner.
create table learner.task_instance (
  id uuid primary key default gen_random_uuid(),
  learner_id text not null check (char_length(learner_id) between 1 and 128),
  assessment_id text not null,
  family_id text not null,
  assessment_version integer not null check (assessment_version >= 1),
  lesson_id text not null,
  delivered_option_ids text[] not null check (cardinality(delivered_option_ids) between 3 and 4),
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index task_instance_learner_family_idx on learner.task_instance (learner_id, family_id);

-- One graded submission per task instance. `correct` is the server grade.
create table learner.attempt_log (
  id uuid primary key default gen_random_uuid(),
  learner_id text not null check (char_length(learner_id) between 1 and 128),
  task_instance_id uuid not null unique references learner.task_instance (id),
  assessment_id text not null,
  family_id text not null,
  assessment_version integer not null check (assessment_version >= 1),
  selected_option_id text not null,
  correct boolean not null,
  hint_level_used smallint not null check (hint_level_used between 0 and 3),
  answer_exposed boolean not null,
  self_confidence smallint check (self_confidence between 1 and 5),
  confidence_signal text,
  evidence_kind text not null check (evidence_kind in ('independent', 'assisted', 'not_counted')),
  evidence_reason text not null,
  primary_concept_ref text,
  resolved_concept_id text,
  concept_resolution text not null check (concept_resolution in ('active', 'split', 'unavailable', 'none')),
  policy_version text not null,
  idempotency_key text not null,
  request_hash text not null,
  created_at timestamptz not null default now(),
  unique (learner_id, idempotency_key),
  check ((self_confidence is null) = (confidence_signal is null))
);
create index attempt_log_learner_family_idx on learner.attempt_log (learner_id, family_id);

-- Help shown to a learner, recorded separately because help can happen
-- without a submitted answer. A retried request reuses its `request_key`.
create table learner.help_event (
  id uuid primary key default gen_random_uuid(),
  learner_id text not null check (char_length(learner_id) between 1 and 128),
  task_instance_id uuid references learner.task_instance (id),
  session_id text,
  family_id text,
  concept_ids text[] not null default '{}' check (cardinality(concept_ids) <= 8),
  level smallint not null check (level between 0 and 3),
  explicit_override boolean not null default false,
  policy_version text not null,
  reason_code text not null,
  request_key text not null,
  created_at timestamptz not null default now(),
  unique (learner_id, request_key)
);
create index help_event_learner_family_idx on learner.help_event (learner_id, family_id);

-- Versioned evidence projection per learner and stable concept id (`cpt-…`).
-- `estimate` is an uncalibrated heuristic, null while independent evidence is missing.
create table learner.concept_mastery (
  learner_id text not null check (char_length(learner_id) between 1 and 128),
  concept_id text not null,
  independent_correct integer not null default 0 check (independent_correct >= 0),
  independent_incorrect integer not null default 0 check (independent_incorrect >= 0),
  assisted_correct integer not null default 0 check (assisted_correct >= 0),
  assisted_incorrect integer not null default 0 check (assisted_incorrect >= 0),
  estimate numeric(5, 4) check (estimate between 0 and 1),
  evidence_status text not null check (evidence_status in ('unknown', 'assisted_only', 'independent')),
  policy_version text not null,
  updated_at timestamptz not null default now(),
  primary key (learner_id, concept_id)
);

-- Private explain-back responses and rubric findings. No writer until PR-8.
create table learner.explanation_log (
  id uuid primary key default gen_random_uuid(),
  learner_id text not null check (char_length(learner_id) between 1 and 128),
  task_id text not null,
  task_version text not null,
  lesson_id text not null,
  rubric_version text not null,
  response text not null,
  criterion_findings jsonb not null default '[]',
  evaluation_status text not null check (evaluation_status in ('pending', 'evaluated', 'deferred', 'failed')),
  model_version text,
  created_at timestamptz not null default now()
);

-- Events committed with the change that caused them. Payloads hold ids and
-- enums only, never learner text. No dispatcher until its first consumer.
create table learner.event_outbox (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'delivered', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now()
);
create index event_outbox_pending_idx on learner.event_outbox (next_attempt_at) where status = 'pending';

alter table learner.task_instance enable row level security;
alter table learner.attempt_log enable row level security;
alter table learner.help_event enable row level security;
alter table learner.concept_mastery enable row level security;
alter table learner.explanation_log enable row level security;
alter table learner.event_outbox enable row level security;

-- The web app's learner-scoped identity. Roles are cluster-wide, so an
-- existing role is reused, but never one that could bypass row level security.
do $$
begin
  create role vertex_learner_app nologin;
exception when duplicate_object or unique_violation then null;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'vertex_learner_app' and (rolsuper or rolbypassrls)) then
    raise exception 'vertex_learner_app must not be a superuser or bypass row level security';
  end if;
  -- Lets the connecting role switch to it per transaction (Postgres 16+ needs SET explicitly).
  if current_setting('server_version_num')::int >= 160000 then
    execute format('grant vertex_learner_app to %I with set true, inherit false', current_user);
  else
    execute format('grant vertex_learner_app to %I', current_user);
  end if;
end
$$;

-- Least privilege: no DELETE anywhere, mastery updates limited to its
-- counters, and the outbox is write-only. `explanation_log` gets nothing
-- until its writer exists (PR-8).
grant usage on schema learner to vertex_learner_app;
grant select, insert on learner.task_instance, learner.attempt_log, learner.help_event to vertex_learner_app;
grant select, insert on learner.concept_mastery to vertex_learner_app;
grant update (
  independent_correct, independent_incorrect, assisted_correct, assisted_incorrect,
  estimate, evidence_status, policy_version, updated_at
) on learner.concept_mastery to vertex_learner_app;
grant insert on learner.event_outbox to vertex_learner_app;

-- One learner per transaction. Unset or empty `app.learner_id` matches nothing.
create policy own_rows on learner.task_instance for all to vertex_learner_app
  using (learner_id = current_setting('app.learner_id', true))
  with check (learner_id = current_setting('app.learner_id', true));
create policy own_rows on learner.attempt_log for all to vertex_learner_app
  using (learner_id = current_setting('app.learner_id', true))
  with check (learner_id = current_setting('app.learner_id', true));
create policy own_rows on learner.help_event for all to vertex_learner_app
  using (learner_id = current_setting('app.learner_id', true))
  with check (learner_id = current_setting('app.learner_id', true));
create policy own_rows on learner.concept_mastery for all to vertex_learner_app
  using (learner_id = current_setting('app.learner_id', true))
  with check (learner_id = current_setting('app.learner_id', true));
create policy own_events on learner.event_outbox for insert to vertex_learner_app
  with check (payload ->> 'learnerId' = current_setting('app.learner_id', true));

-- Supabase's Data API roles. Absent on a plain Postgres, hence the guard.
do $$
declare
  api_role text;
begin
  foreach api_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = api_role) then
      execute format('revoke all on schema learner from %I', api_role);
      execute format('revoke all on all tables in schema learner from %I', api_role);
      execute format('alter default privileges in schema learner revoke all on tables from %I', api_role);
    end if;
  end loop;
end
$$;
