-- PR-6: time-anchored tutor requests (development plan §5 PR-6).
--
-- One row per tutor question that reached an outcome: the scope searched,
-- the status returned, and how many sources were given and cited. It backs
-- the per-learner hourly budget and request-key replay detection, including
-- for outcomes that deliver no help and so record no `help_event`.
--
-- No question, answer, or source text is stored. `lesson_id` is an
-- application-validated Sanity id, not a foreign key. Additive only:
-- rollback disables the route and keeps every row.

create table learner.tutor_request (
  id uuid primary key default gen_random_uuid(),
  learner_id text not null check (char_length(learner_id) between 1 and 128),
  request_key text not null,
  lesson_id text not null,
  task_instance_id uuid references learner.task_instance (id),
  session_id text check (char_length(session_id) <= 64),
  help_event_id uuid references learner.help_event (id),
  status text not null check (status in ('supported', 'partial', 'insufficient_evidence', 'clarification_needed')),
  scope text not null check (scope in ('window', 'lesson', 'course')),
  evidence_count smallint not null check (evidence_count between 0 and 64),
  cited_count smallint not null check (cited_count between 0 and 64),
  prompt_version text not null,
  model_id text,
  created_at timestamptz not null default now(),
  unique (learner_id, request_key),
  -- Help is recorded exactly when it was delivered.
  check ((help_event_id is null) = (status = 'insufficient_evidence'))
);
create index tutor_request_learner_created_idx on learner.tutor_request (learner_id, created_at);

alter table learner.tutor_request enable row level security;

-- Least privilege, as in 0001: the service only reads (budget, replay) and inserts.
grant select, insert on learner.tutor_request to vertex_learner_app;

create policy own_rows on learner.tutor_request for all to vertex_learner_app
  using (learner_id = current_setting('app.learner_id', true))
  with check (learner_id = current_setting('app.learner_id', true));

-- Supabase's Data API roles, as in 0001. Default privileges only cover tables
-- created by the role that set them, so revoke on this table explicitly.
do $$
declare
  api_role text;
begin
  foreach api_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = api_role) then
      execute format('revoke all on learner.tutor_request from %I', api_role);
    end if;
  end loop;
end
$$;
