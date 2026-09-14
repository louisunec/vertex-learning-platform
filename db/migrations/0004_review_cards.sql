-- Scheduled review (development plan §5 PR-9; prompts/pr-9-scheduled-review.md).
--
-- `review_card` holds one learner's complete ts-fsrs card state for one
-- concept and item type (recall / apply / transfer), so recognition and
-- transfer never share a schedule. `review_log` is the immutable record of
-- every graded answer that reached a card: a rating (Again or Good only), or
-- an unrated assisted correct answer, which leaves the card unchanged. Both
-- are written in the attempt's own transaction; one row per attempt.
--
-- Focused review sessions gain a `mode`: existing rows stay `mistakes`, and
-- `scheduled` sessions serve due cards (reason `scheduled_due`, with the card
-- and whether the question was answered before). Additive only: rollback
-- turns the `scheduled-review` flag off and keeps every row.

create table learner.review_card (
  id uuid primary key default gen_random_uuid(),
  learner_id text not null check (char_length(learner_id) between 1 and 128),
  concept_id text not null check (char_length(concept_id) between 1 and 128),
  task_type text not null check (task_type in ('recall', 'apply', 'transfer')),
  -- ts-fsrs `Card` (5.4.2), field for field.
  due timestamptz not null,
  stability double precision not null check (stability >= 0),
  difficulty double precision not null check (difficulty >= 0),
  elapsed_days integer not null check (elapsed_days >= 0),
  scheduled_days integer not null check (scheduled_days >= 0),
  learning_steps integer not null check (learning_steps >= 0),
  reps integer not null check (reps >= 0),
  lapses integer not null check (lapses >= 0),
  state smallint not null check (state between 0 and 3),
  last_review timestamptz,
  algorithm_version text not null,
  params_version text not null,
  rating_policy_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (learner_id, concept_id, task_type)
);
create index review_card_learner_due_idx on learner.review_card (learner_id, due);

create table learner.review_log (
  id uuid primary key default gen_random_uuid(),
  learner_id text not null check (char_length(learner_id) between 1 and 128),
  card_id uuid not null references learner.review_card (id),
  attempt_id uuid not null unique references learner.attempt_log (id),
  outcome text not null check (outcome in ('rated', 'unrated_assisted_correct')),
  -- ts-fsrs Rating: 1 = Again, 3 = Good. Hard and Easy are never recorded.
  rating smallint check (rating in (1, 3)),
  previous_state jsonb not null,
  new_state jsonb not null,
  reviewed_at timestamptz not null,
  algorithm_version text not null,
  params_version text not null,
  rating_policy_version text not null,
  created_at timestamptz not null default now(),
  check ((outcome = 'rated') = (rating is not null))
);
create index review_log_card_idx on learner.review_log (card_id, reviewed_at);

alter table learner.review_session
  add column mode text not null default 'mistakes' check (mode in ('mistakes', 'scheduled'));
create index review_session_learner_mode_expires_idx on learner.review_session (learner_id, mode, expires_at);

alter table learner.review_session_item
  drop constraint review_session_item_reason_check,
  add constraint review_session_item_reason_check
    check (reason in ('independent_incorrect', 'assisted_incorrect', 'assisted_correct', 'scheduled_due')),
  add column card_id uuid references learner.review_card (id),
  add column repeat boolean not null default false,
  add constraint review_session_item_card_check check ((reason = 'scheduled_due') = (card_id is not null));

alter table learner.review_card enable row level security;
alter table learner.review_log enable row level security;

-- Least privilege, as in 0001: cards are read, inserted, and have only their
-- scheduler state updated; the log is read and appended to, never changed.
grant select, insert on learner.review_card, learner.review_log to vertex_learner_app;
grant update (
  due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review,
  algorithm_version, params_version, rating_policy_version, updated_at
) on learner.review_card to vertex_learner_app;

create policy own_rows on learner.review_card for all to vertex_learner_app
  using (learner_id = current_setting('app.learner_id', true))
  with check (learner_id = current_setting('app.learner_id', true));
create policy own_rows on learner.review_log for all to vertex_learner_app
  using (learner_id = current_setting('app.learner_id', true))
  with check (learner_id = current_setting('app.learner_id', true));

-- Supabase's Data API roles, as in 0002.
do $$
declare
  api_role text;
begin
  foreach api_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = api_role) then
      execute format('revoke all on learner.review_card, learner.review_log from %I', api_role);
    end if;
  end loop;
end
$$;
