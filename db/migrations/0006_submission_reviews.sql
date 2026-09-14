-- PR-12: learner submission review (development plan §5 PR-12).
--
-- Numbered 0006 because 0003–0005 are taken on sibling branches (focused
-- review, scheduled review, next action) and the runner keys on file names.
--
-- `submission_review` is the private analysis of one piece of code for one
-- learner, cached under a key over the task version and content hash, the
-- submitted code's hash, and the prompt and model versions. `learner_id` is
-- part of the key and of every policy, so a result is never shared between
-- learners. `submission_log` has one row per review request: its idempotency
-- key, what was submitted (hash and size only), and how it counts as evidence.
--
-- The submitted code itself is not stored: only its sha256 is. The analysis
-- holds the model's own questions, explanations, and corrections. Help given
-- on a review is a `help_event` (0001) scoped to the task. Nothing here feeds
-- `concept_mastery`: a model review is not an independent grade. Task and
-- lesson ids are application-validated Sanity ids, not foreign keys.
-- Additive only: rollback disables the route and keeps every row.

create table learner.submission_review (
  id uuid primary key default gen_random_uuid(),
  learner_id text not null check (char_length(learner_id) between 1 and 128),
  cache_key text not null check (cache_key ~ '^[0-9a-f]{64}$'),
  task_id text not null check (char_length(task_id) between 1 and 64),
  task_version integer not null check (task_version >= 1),
  task_hash text not null check (task_hash ~ '^[0-9a-f]{64}$'),
  lesson_id text not null,
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  line_count smallint not null check (line_count between 1 and 200),
  prompt_version text not null,
  check_version text not null,
  model_id text not null,
  -- `pending` while one request holds the claim (the model runs outside any
  -- transaction); `failed` after a provider error, so a retry re-evaluates.
  status text not null check (status in ('pending', 'completed', 'failed')),
  outcome text check (outcome in ('changes_suggested', 'partly_judged', 'no_issues_found', 'cannot_judge')),
  analysis jsonb,
  claim_token uuid not null,
  claimed_at timestamptz not null default now(),
  evaluations smallint not null default 1 check (evaluations between 1 and 1000),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (learner_id, cache_key),
  check ((status = 'completed') = (outcome is not null and analysis is not null and completed_at is not null))
);
create index submission_review_learner_claimed_idx on learner.submission_review (learner_id, claimed_at);

create table learner.submission_log (
  id uuid primary key default gen_random_uuid(),
  learner_id text not null check (char_length(learner_id) between 1 and 128),
  request_key text not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  review_id uuid not null references learner.submission_review (id),
  task_id text not null check (char_length(task_id) between 1 and 64),
  task_version integer not null check (task_version >= 1),
  lesson_id text not null,
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  line_count smallint not null check (line_count between 1 and 200),
  char_count integer not null check (char_count between 1 and 8000),
  -- The analysis was reused: identical code on this task version was reviewed before.
  cache_hit boolean not null,
  evidence_kind text not null check (evidence_kind in ('independent', 'assisted', 'not_counted')),
  evidence_reason text not null check (
    evidence_reason in ('first_independent_response', 'hint_used', 'answer_exposed', 'repeat_task', 'repeat_submission')
  ),
  -- Highest help on the task (any version) before this submission, and the level shown with it.
  help_level_before smallint not null check (help_level_before between 0 and 3),
  help_level smallint not null check (help_level between 0 and 3),
  -- The `help_event` recorded in the same transaction. Deliberately not a
  -- foreign key: a reference into 0001's tables would make every existing
  -- `truncate learner.help_event` (tests, local resets) name these tables too.
  help_event_id uuid,
  created_at timestamptz not null default now(),
  unique (learner_id, request_key)
);
create index submission_log_learner_task_idx on learner.submission_log (learner_id, task_id);

alter table learner.submission_review enable row level security;
alter table learner.submission_log enable row level security;

-- Least privilege, as in 0001/0002: no DELETE; a review's content columns
-- are written once at completion, and only its claim and result columns can change.
grant select, insert on learner.submission_review, learner.submission_log to vertex_learner_app;
grant update (status, outcome, analysis, claim_token, claimed_at, evaluations, completed_at)
  on learner.submission_review to vertex_learner_app;

create policy own_rows on learner.submission_review for all to vertex_learner_app
  using (learner_id = current_setting('app.learner_id', true))
  with check (learner_id = current_setting('app.learner_id', true));
create policy own_rows on learner.submission_log for all to vertex_learner_app
  using (learner_id = current_setting('app.learner_id', true))
  with check (learner_id = current_setting('app.learner_id', true));

-- Supabase's Data API roles, as in 0002: default privileges only cover
-- tables created by the role that set them, so revoke on these explicitly.
do $$
declare
  api_role text;
begin
  foreach api_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = api_role) then
      execute format('revoke all on learner.submission_review, learner.submission_log from %I', api_role);
    end if;
  end loop;
end
$$;
