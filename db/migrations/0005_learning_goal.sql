-- PR-11: the learner's current learning goal (development plan §5 PR-11).
--
-- One row per learner: the goal they chose themselves on My Learning. The
-- server never infers or saves a goal without an explicit request. Only a
-- course goal exists today (`goal_kind = 'course'`); the kind column keeps
-- the model open to other goal types without allowing them yet.
--
-- `course_id` is a Sanity course document id, validated as a published
-- course when the goal is saved and again whenever a plan is built (an
-- unpublished course reads as "goal unavailable"). It is an
-- application-validated external id, not a foreign key. Numbered 0005
-- because 0003 is the focused review and 0004 is reserved for PR-9; the
-- migrator applies pending files in name order. Additive only: rollback
-- disables the routes and keeps every row.

create table learner.learning_goal (
  learner_id text primary key check (char_length(learner_id) between 1 and 128),
  goal_kind text not null default 'course' check (goal_kind in ('course')),
  course_id text not null check (char_length(course_id) between 1 and 128),
  set_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table learner.learning_goal enable row level security;

-- Least privilege, as in 0001: read, create, and change the goal; no DELETE.
grant select, insert on learner.learning_goal to vertex_learner_app;
grant update (goal_kind, course_id, set_at, updated_at) on learner.learning_goal to vertex_learner_app;

create policy own_rows on learner.learning_goal for all to vertex_learner_app
  using (learner_id = current_setting('app.learner_id', true))
  with check (learner_id = current_setting('app.learner_id', true));

-- Supabase's Data API roles, as in 0002: revoke on this table explicitly.
do $$
declare
  api_role text;
begin
  foreach api_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = api_role) then
      execute format('revoke all on learner.learning_goal from %I', api_role);
    end if;
  end loop;
end
$$;
