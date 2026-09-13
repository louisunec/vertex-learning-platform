-- Focused review sessions (prompts/focused-review.md).
--
-- A session is a bounded, server-chosen list of task instances (at most 5)
-- on concepts the learner recently answered wrong or with help. It pins the
-- order and the reason each concept was chosen, so "question 2 of 5" and
-- "Save and leave" survive a reload; whether an item was answered is read
-- from `attempt_log`, never stored here. It is not a spaced-repetition
-- scheduler and stores no scheduler state.
--
-- `concept_id` is the stable concept id (as in `attempt_log`), and
-- `source_seconds` the item's earliest cited second when the session was
-- built, for the refresher link. Additive only: rollback disables the route
-- and keeps every row.

create table learner.review_session (
  id uuid primary key default gen_random_uuid(),
  learner_id text not null check (char_length(learner_id) between 1 and 128),
  policy_version text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index review_session_learner_expires_idx on learner.review_session (learner_id, expires_at);

create table learner.review_session_item (
  session_id uuid not null references learner.review_session (id),
  learner_id text not null check (char_length(learner_id) between 1 and 128),
  position smallint not null check (position between 1 and 5),
  concept_id text not null check (char_length(concept_id) between 1 and 128),
  reason text not null check (reason in ('independent_incorrect', 'assisted_incorrect', 'assisted_correct')),
  task_instance_id uuid not null unique references learner.task_instance (id),
  source_seconds integer check (source_seconds >= 0),
  primary key (session_id, position)
);

alter table learner.review_session enable row level security;
alter table learner.review_session_item enable row level security;

-- Least privilege, as in 0001: the service only reads and inserts.
grant select, insert on learner.review_session, learner.review_session_item to vertex_learner_app;

create policy own_rows on learner.review_session for all to vertex_learner_app
  using (learner_id = current_setting('app.learner_id', true))
  with check (learner_id = current_setting('app.learner_id', true));
create policy own_rows on learner.review_session_item for all to vertex_learner_app
  using (learner_id = current_setting('app.learner_id', true))
  with check (learner_id = current_setting('app.learner_id', true));
