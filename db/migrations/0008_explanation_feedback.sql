-- PR-8: explain-back feedback (development plan §5 PR-8).
--
-- Numbered 0008 because 0003–0007 are taken on sibling branches (focused
-- review, scheduled review, next action, submission review, editorial
-- signals) and the runner keys on file names. Nothing here depends on them.
--
-- 0001 created `learner.explanation_log` with no writer and no grants. This
-- migration gives it its writer instead of adding a parallel table: one row
-- per explanation request (its idempotency key), holding the learner's
-- private text, the task, rubric, and source versions it was judged against,
-- the stored feedback, the model, prompt, and validator versions, and how it
-- counts as evidence (a revision after feedback, help seen before, a repeat).
--
-- The table may already exist in shared databases, so every new column is
-- nullable or defaulted, and the rules for new rows are `not valid` check
-- constraints: enforced on every insert and update from now on, without
-- re-checking rows that predate this migration.
--
-- The text is stored privately (the plan's "private response"). It never
-- reaches the outbox, analytics, or logs. Nothing here feeds
-- `concept_mastery`: an explanation is its own evidence type, and a model's
-- reading of it is not a grade. Task, lesson, concept, and chunk ids are
-- application-validated Sanity ids, not foreign keys. Additive only:
-- rollback disables the route and keeps every row.

alter table learner.explanation_log
  add column request_key text,
  add column request_hash text,
  -- Identical text on the same task content, prompt, validator, and model, for this learner.
  add column cache_key text,
  add column response_hash text,
  add column char_count integer,
  add column task_hash text,
  -- The chunk ids and revisions the rubric cited when this was judged.
  add column source_refs jsonb,
  add column concept_ids text[],
  add column prompt_version text,
  add column validator_version text,
  add column outcome text,
  -- `pending` while one request holds the claim (the model runs outside any
  -- transaction); `failed` after a provider error, so a retry re-evaluates.
  add column claim_token uuid,
  add column claimed_at timestamptz,
  add column evaluations smallint not null default 1,
  add column completed_at timestamptz,
  add column cache_hit boolean,
  -- The earlier explanation whose evaluation was reused for identical text.
  add column reused_from uuid references learner.explanation_log (id),
  -- The latest earlier assessed explanation of the task: this one followed its feedback.
  add column revision_of uuid references learner.explanation_log (id),
  add column attempt_number smallint,
  add column feedback_exposed boolean,
  -- Highest help level recorded on the lesson or the task's concepts before this explanation.
  add column help_level_before smallint,
  add column evidence_kind text,
  add column evidence_reason text;

alter table learner.explanation_log
  add constraint explanation_log_learner_request_key unique (learner_id, request_key);

alter table learner.explanation_log
  -- `coalesce`: a check passes on NULL, and every one of these is required.
  -- `char_count` is the browser's UTF-16 length, the unit spans are measured in.
  add constraint explanation_log_request_columns check (coalesce(
    request_key ~ '^[A-Za-z0-9_-]{16,64}$'
    and request_hash ~ '^[0-9a-f]{64}$'
    and cache_key ~ '^[0-9a-f]{64}$'
    and response_hash ~ '^[0-9a-f]{64}$'
    and char_count between 1 and 1500
    and task_hash ~ '^[0-9a-f]{64}$'
    and rubric_version ~ '^[0-9a-f]{64}$'
    and jsonb_typeof(source_refs) = 'array'
    and concept_ids is not null
    and cardinality(concept_ids) <= 8
    and prompt_version is not null
    and validator_version is not null
    and claim_token is not null
    and claimed_at is not null
    and evaluations between 1 and 1000,
    false
  )) not valid,
  add constraint explanation_log_outcome check (outcome in ('assessed', 'off_topic')) not valid,
  add constraint explanation_log_evidence check (
    evidence_kind in ('independent', 'assisted', 'not_counted')
    and evidence_reason in (
      'first_independent_response', 'hint_used', 'answer_exposed', 'revision_after_feedback', 'repeat_submission', 'not_assessable'
    )
    and help_level_before between 0 and 3
    and attempt_number >= 1
  ) not valid,
  -- A completed explanation carries its feedback and classification; any other state carries neither.
  add constraint explanation_log_completion check (
    (evaluation_status in ('evaluated', 'deferred')) = (
      outcome is not null and completed_at is not null and model_version is not null and cache_hit is not null
      and attempt_number is not null and feedback_exposed is not null and help_level_before is not null
      and evidence_kind is not null and evidence_reason is not null
    )
    and (evaluation_status in ('evaluated', 'deferred') or (revision_of is null and reused_from is null))
  ) not valid;

create index explanation_log_learner_task_idx on learner.explanation_log (learner_id, task_id, completed_at);
create index explanation_log_learner_cache_idx on learner.explanation_log (learner_id, cache_key);
create index explanation_log_learner_claimed_idx on learner.explanation_log (learner_id, claimed_at);

-- Least privilege, as in 0001/0002: no DELETE; a row's request columns are
-- written once, and only its claim and completion columns can change.
grant select, insert on learner.explanation_log to vertex_learner_app;
grant update (
  evaluation_status, outcome, criterion_findings, model_version, claim_token, claimed_at, evaluations, completed_at,
  cache_hit, reused_from, revision_of, attempt_number, feedback_exposed, help_level_before, evidence_kind, evidence_reason
) on learner.explanation_log to vertex_learner_app;

create policy own_rows on learner.explanation_log for all to vertex_learner_app
  using (learner_id = current_setting('app.learner_id', true))
  with check (learner_id = current_setting('app.learner_id', true));

-- Supabase's Data API roles, as in 0002: revoke on this table explicitly.
do $$
declare
  api_role text;
begin
  foreach api_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = api_role) then
      execute format('revoke all on learner.explanation_log from %I', api_role);
    end if;
  end loop;
end
$$;
