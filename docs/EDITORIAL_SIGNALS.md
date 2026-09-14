# Editorial learning signals (PR-10)

Signals help instructors find content worth checking:

- assessment versions with a high first-attempt error rate;
- lesson moments that many learners replay;
- searches that returned no grounded results, and tutor questions answered with insufficient evidence.

A signal is a reason to investigate. It is never proof that content is wrong. The decision record is `prompts/pr-10-editorial-signals.md`.

Everything here is offline tooling. None of it runs in a request path, and no job is scheduled by this repository.

## Commands

| Command | What it does |
| --- | --- |
| `npm run outbox -- dispatch` | Delivers due learner outbox events to PostHog |
| `npm run outbox -- dispatch --dry-run` | Prints exactly what would be sent. Claims and sends nothing |
| `npm run outbox -- status` | Counts by status and type, due, backing-off, in-flight and abandoned claims, held event types, dead letters, recent runs |
| `npm run outbox -- requeue [--event-type T] [--limit N]` | Moves dead-lettered events back to pending with a fresh attempt budget |
| `npm run signals -- aggregate` | Computes signals for the last completed 7-day window, plus one earlier window (late events) |
| `npm run signals -- aggregate --include-current` | Also computes the window in progress, marked partial |
| `npm run signals -- aggregate --dry-run --out file.json` | Computes and prints; writes nothing to Sanity, the queue, or the job log |
| `npm run signals -- status` | Recent aggregation runs with per-type counts and exclusions, the regeneration queue, and synthetic labels |
| `npm run signals -- synthetic add <clerk-id> --label demo\|test\|synthetic\|staff` | Excludes an account from aggregates and from analytics delivery |
| `npm run signals -- regenerate` | Lists queued draft regeneration candidates |
| `npm run signals -- regenerate --execute` | Drafts replacements for queued candidates. Needs `SIGNALS_REGENERATION_ENABLED=true` |
| `npm run signals:fixture` | Seeds FIXTURE records into a local `vertex_fixture*` database, for demonstrations |

Useful `aggregate` flags:

- `--as-of <date>`
- `--window-days 1..28`
- `--lookback N`
- `--types a,b`
- `--events <fixture.json>`: fixture events instead of PostHog; the signals are labelled as fixtures;
- `--fixture`
- `--no-regeneration`

## Credentials

| Variable | Used by | Notes |
| --- | --- | --- |
| `DATABASE_URL` | both jobs | The owner connection. Every query runs as `vertex_signals_worker` (migration 0007), which cannot bypass RLS, has no DELETE, and can update only the outbox's delivery columns |
| `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN`, `NEXT_PUBLIC_POSTHOG_HOST` | dispatch | The public capture token and host (`/batch/`) |
| `POSTHOG_PERSONAL_API_KEY`, `POSTHOG_PROJECT_ID`, optional `POSTHOG_API_HOST` | aggregate (replay, search) | A personal key with the `query:read` scope. The `phs_` feature-flag secret cannot query. Without these, replay and search signals are skipped and reported |
| `SANITY_API_SIGNALS_WRITE_TOKEN` | aggregate, regenerate | Writes `contentSignal` documents. Separate from the app's tokens |
| `SANITY_API_WRITE_TOKEN`, `OPENAI_API_KEY` | regenerate `--execute` | The existing generator credentials |
| `SIGNALS_REGENERATION_ENABLED` | regenerate `--execute` | Off unless exactly `true` |

In production, prefer a dedicated LOGIN database user that is a member of `vertex_signals_worker`, rather than the owner connection.

## Delivery guarantee (outbox → PostHog)

Delivery is at-least-once, with a stable event id: the PostHog `uuid` is the outbox row id and the `timestamp` is the row's `created_at`.

- **Claiming:** workers claim rows with a lease (`FOR UPDATE SKIP LOCKED`), so concurrent dispatchers never take the same row. A crashed worker's lease expires, and the row is claimed again.
- **Accepted, then not recorded:** if PostHog accepts a batch but recording `delivered` fails, the rows keep their lease. A later run resends them unchanged: the same `uuid`, `event`, `timestamp` and `distinct_id`, the four fields PostHog merges duplicates on.
- **Deduplication downstream:** PostHog's merge is eventual, done during background ClickHouse merges, and [not guaranteed](https://posthog.com/docs/data/events). A query can see both copies for a while.
  - The signal readers (`lib/signals/posthog-reader.ts`) return each `uuid` once.
  - Anyone counting outbox events in PostHog should use `count(distinct uuid)`.
- **Exactly-once is not claimed:** delivery is at-least-once everywhere.
- **Failures:** a failed send backs off exponentially (30 s doubling, capped at 6 h). After 8 attempts the row is dead-lettered (`failed`).
- **Never sent:**
  - events of labelled synthetic learners (`suppressed`);
  - events whose payload fails their approved projection, which are dead-lettered (`invalid_payload`), shown in `status` and requeueable;
  - events of a type with no approved projection. These are **held**: never claimed, dropped, dead-lettered or marked delivered. They stay `pending` with their attempt budget, `status` lists them, and they are sent once a projection is added.
- **Grading:** grading and mastery never wait for PostHog. Attempts commit their outbox rows in their own transactions.

### Approved fields

| Event | Properties |
| --- | --- |
| `attempt_graded` | `assessment_id`, `family_id`, `assessment_version`, `concept_id`, `correct`, `evidence_kind`, `evidence_reason`, `policy_version` |
| `help_level_decided` | `family_id`, `level`, `reason_code`, `explicit_override`, `policy_version` |
| `tutor_answered` | `lesson_id`, `status`, `scope`, `evidence_count`, `cited_count`, `dropped_statements`, `support_check`, `prompt_version` |
| `submission_reviewed` (PR-12) | `task_id`, `task_version`, `lesson_id`, `outcome`, `findings_defect`, `findings_requirement_mismatch`, `findings_alternative_valid`, `findings_uncertain`, `dropped_findings`, `cache_hit`, `evidence_kind`, `evidence_reason`, `help_level`, `prompt_version`, `check_version` |

- Every event also carries `source: "learner_outbox"`.
- The learner's Clerk id is the `distinct_id`, the same id `posthog-identity.tsx` identifies with. It is never a property.
- Internal row ids and all text are dropped.
- `submission_reviewed` drops PR-12's submission, review and help-event ids. The submitted code and the findings' text are not in its payload.
- Any other new outbox event type is held until a projection is added to `lib/outbox/projection.ts`.

## Signals

| Type | Source | Raised when (defaults, `lib/signals/config.ts`) | Denominator |
| --- | --- | --- | --- |
| High first-attempt error rate | Postgres `attempt_log` | More than 60 % incorrect over at least 20 independent first attempts on one assessment version | Independent first attempts: each learner's first response to the family, as this version, with no hint. Assisted attempts and retries are shown separately |
| Tutor found insufficient supporting material | Postgres `tutor_request` | At least 3 distinct learners get `insufficient_evidence` on one lesson | Tutor questions answered on the lesson |
| Repeated replays | PostHog `video_seeked`, `video_played` | At least 5 distinct people, and at least 20 % of viewers, replay the same 30-second stretch | People who played the lesson's video in the window with seek tracking on (`video_played.seek_tracking`) |
| Searches with no grounded results | PostHog `search_outcome` | At least 3 distinct people get `no_results` for the same tokenized terms | Searches with those terms |

Exclusions:

- **Assessment signals:** labelled synthetic learners.
- **Replay signals:** tutor citation jumps, skips, and far rewinds. Plays without seek tracking are left out of the denominator (`untracked_plays`).
- **Search signals:** interpretation fallbacks after provider errors (`no_results_degraded`), MCP outages (`unavailable`), `failed`, and `no_terms`. These appear in the run summary, never as content gaps.
- **Tutor signals:** tutor provider and retrieval outages are never recorded as `tutor_request` rows, so they cannot become signals.

Windows and idempotency:

- Windows are fixed, half-open UTC intervals aligned to Mondays.
- Each signal's id is `contentSignal-<type>-<subject hash>-<window>`. A rerun replaces its counts and never adds to them.
- A rerun never touches the review status, note, or regeneration fields.
- A signal that no longer meets its threshold on a rerun is kept, with `thresholdMet: false`.

## Instrumentation (flag `editorial-signals`)

Both events are behind the `editorial-signals` PostHog flag. It fails closed, and is not created by this PR.

- **Neither event adds a server-side flag check to the lesson page.** The lesson page never evaluates this flag while rendering.
  - **`video_seeked`:** the player reads the flag from posthog-js, which already loads flags in the browser on every page. It decides once per view, at the first play.
  - **`search_outcome`:** evaluated with local evaluation only (`onlyEvaluateLocally`), after the response is sent.
- **Roll it out by percentage only.** Local evaluation cannot match person-property or cohort conditions, or "persist across authentication"; with those, the server-side event reads as off.
- **Why not create the flag and evaluate it on the server?** Probed against a local fake PostHog, posthog-node still made a remote `/flags` request on every evaluation when:
  - the flag was missing;
  - it had a person-property condition;
  - it used experience continuity;
  - definitions were quota-limited;
  - `POSTHOG_SECRET_KEY` was unset.
  - It also waited for the full definitions download (2.5 s in the probe) on a cold process, whatever the flag's state.

- **`video_seeked`** (lesson player, YouTube only):
  - `from_seconds`, `to_seconds`;
  - `seek_kind`: `replay | skip | rewind_far`;
  - `seek_origin`: `learner | citation`;
  - `lesson_id`, `video_id`.
  - `video_played` and the watch-depth events now also carry `lesson_id` and `video_id`.
  - `video_played` also carries `seek_tracking` (true or false), the per-view decision above.
- **`search_outcome`** (server, first result pages only):
  - `outcome`, `interpretation`, `result_count`;
  - `terms`, `terms_fingerprint`: at most six tokenized keywords, never the raw query. Tokenized is not scrubbed: a name or email typed into a query can still appear as keywords.
- The browser's `search_performed` and `search_result_clicked` no longer carry `query`. They keep `query_length`, the status, counts and position.
  - posthog-js pageviews still record the `/search?q=…` URL in `$current_url`. That leak is not addressed here.

## Studio

Content signals (in the Studio structure) has lists:

- by review status: Open, Investigating, Acknowledged, Resolved;
- No longer meets its threshold;
- by type;
- All signals.

The document actions "Start investigating", "Acknowledge", "Resolve" and "Reopen" set the review status and stamp who changed it and when. Signals are `liveEdit`, cannot be created, duplicated or deleted in the Studio, and are outside the Context MCP scope.

## Regeneration

- **Queueing:** a raised assessment signal queues at most one draft candidate per source revision (the generation span key) per UTC day, and at most 5 a day in total. The queue is `editorial.regeneration_candidate`.
- **Execution:**
  - off by default;
  - reuses `processLesson` for the flagged unit only;
  - skips units with an unpublished draft or a newer version;
  - refuses any write other than new drafts pending review, plus the unit's generation record.
- **Never:** it never publishes, approves, deletes, or changes a published version or a learner's history.

## Suggested schedules (not enabled)

Example crontab for a trusted worker host with the variables above:

```cron
*/5 * * * *  cd /srv/vertex && npm run -s outbox -- dispatch
30 2 * * *   cd /srv/vertex && npm run -s signals -- aggregate --include-current
```

Keep regeneration manual until drafts from it have been reviewed.

## Rollback

- Stop the schedules.
- Turn the `editorial-signals` flag off, which stops the two new events.
- Tables and documents stay: migration 0007 is additive. Outbox rows remain `pending` and are delivered when dispatch resumes.

## Fixture demonstration

```sh
FIXTURE_DATABASE_URL=postgres://postgres:postgres@localhost:54336/vertex_fixture_signals npm run signals:fixture
DATABASE_URL=postgres://postgres:postgres@localhost:54336/vertex_fixture_signals \
  npm run signals -- aggregate --as-of 2026-09-14 --lookback 0 \
  --events docs/editorial-signals/fixture-events.json --dry-run
```

This raises one fixture signal of each type:

- v2 at 72 % of 25;
- replays at 1:30, 6 of 10 viewers;
- the "oauth refresh rotate token" search, 4 people;
- tutor insufficient evidence on `lesson-reading`, 3 learners.

The search outage stays in the excluded counts. Writing fixture signals to the `production` dataset is refused.
