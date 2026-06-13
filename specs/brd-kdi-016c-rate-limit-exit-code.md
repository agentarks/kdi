# BRD-KDI-016c: Rate-Limit Exit Code Handling

-------------------------------------------------------------------------------
Business Goal
-------------------------------------------------------------------------------
When an agent harness hits a provider rate limit it typically exits with
`EX_TEMPFAIL` (exit code 75). The dispatcher must recognize this transient
condition, return the task to the `ready` queue without burning its retry
budget, and wait a configurable cooldown before attempting the harness again.
This prevents the dispatcher from hammering a rate-limited provider while still
retrying the task automatically.

-------------------------------------------------------------------------------
User Stories
-------------------------------------------------------------------------------
1. As an operator, I want rate-limited task attempts to be retried without
   incrementing `consecutive_failures`, so the retry budget is reserved for
   real failures.
2. As a board administrator, I want to see when a task is cooling down from a
   rate limit via `kdi show`.
3. As a harness author, I want the dispatcher to back off after an EX_TEMPFAIL
   so the provider account is not flooded with immediate retries.

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------
- `tasks.rate_limited_until INTEGER` stores the Unix epoch after which a
  rate-limited task is eligible to be claimed again. A `NULL` value means the
  task is not currently rate-limited.
- A harness that exits with code 75 is treated as a rate-limit transient when
  `ff_rate_limit_exit_code` is enabled.
- On exit 75 the task transitions to `ready`, the active claim is cleared,
  `consecutive_failures` is left unchanged, and `rate_limited_until` is set to
  `now + cooldown_seconds`.
- The active `task_runs` row is finalized with `outcome = 'reclaimed'` and
  `status = 'released'`, with the error field set to a rate-limit message.
  A `rate_limited` event is recorded with the cooldown timestamp and any
  harness stderr/stdout.
- The dispatcher's ready-task query skips tasks where `rate_limited_until` is
  in the future.
- `atomicClaim` clears `rate_limited_until` when it claims a task, so a
  successful retry removes the cooldown.
- The cooldown is configurable via:
  - `kdi dispatch --rate-limit-cooldown <duration>` (default `60s`).
  - Environment variable `KDI_RATE_LIMIT_COOLDOWN_SECONDS` (overridden by the
    CLI option).
- Duration syntax uses the existing parser: raw seconds or suffixes (`30s`,
  `5m`, `1h`).
- When `ff_rate_limit_exit_code` is disabled, exit 75 is processed by the
  normal failure path (`handleFailure`), increments `consecutive_failures`,
  and respects `max_retries`.
- `kdi show <id>` displays `Rate limited until: <ISO8601>` when the flag is
  enabled and the column is set.

-------------------------------------------------------------------------------
Non-Functional Requirements
-------------------------------------------------------------------------------
- CLI response time remains sub-100ms.
- No visible change to `kdi show` output when the flag is disabled.
- Migration is idempotent and safe for existing databases.

-------------------------------------------------------------------------------
Feature Flag Requirements
-------------------------------------------------------------------------------
- `ff_rate_limit_exit_code` registered in `src/flags.ts`:
  ```ts
  export const FF_RATE_LIMIT_EXIT_CODE = "FF_RATE_LIMIT_EXIT_CODE";
  registerFlag(FF_RATE_LIMIT_EXIT_CODE, false);
  ```
- Env var form: `FF_RATE_LIMIT_EXIT_CODE=false`.
- Defaults to `false` in every environment.
- `kdi dispatch --rate-limit-cooldown` is rejected when the flag is disabled.

-------------------------------------------------------------------------------
Schema Changes
-------------------------------------------------------------------------------
- Add `rate_limited_until INTEGER` to `tasks` (guarded migration in
  `src/db.ts`).
- Add index:
  ```sql
  CREATE INDEX IF NOT EXISTS idx_tasks_rate_limited_until
    ON tasks(status, rate_limited_until);
  ```
- Update the `Task` interface and `TASK_COLUMNS` in `src/models/task.ts` to
  include `rate_limited_until`.
- Update `hydrateTask` to normalize `rate_limited_until` to a number or `null`.

No changes to `task_runs` are required; the rate-limit run is finalized using
 the existing `reclaimed` outcome and a dedicated `rate_limited` event.

-------------------------------------------------------------------------------
CLI Surface
-------------------------------------------------------------------------------
- `kdi dispatch --rate-limit-cooldown <duration>` overrides the default
  cooldown for that dispatcher invocation.
- `kdi show <id>` displays the cooldown timestamp when set and the flag is
  enabled.
- No new top-level command is introduced.

-------------------------------------------------------------------------------
Dispatcher Behavior
-------------------------------------------------------------------------------
1. Add `rateLimitCooldownSeconds` to `TickOptions`. The `dispatch` command
   parses `--rate-limit-cooldown` with `parseDuration` and passes the value to
   `tick`. The default is `60` seconds, overridable via
   `KDI_RATE_LIMIT_COOLDOWN_SECONDS`.
2. `listReadyTasks` adds the guard:
   ```sql
   AND (rate_limited_until IS NULL OR rate_limited_until <= unixepoch())
   ```
3. `atomicClaim` adds the same guard to its claim predicate and clears
   `rate_limited_until` in the `UPDATE`.
4. On harness exit:
   - If `exitCode === 75` and `ff_rate_limit_exit_code` is enabled:
     - Compute `cooldownUntil = now + cooldownSeconds`.
     - Update task: `status='ready'`, clear `claim_lock`, `claim_expires`,
       `started_at`, and `current_run_id`, set `rate_limited_until` to
       `cooldownUntil`, and leave `consecutive_failures` unchanged.
     - Finalize active run with `outcome='reclaimed'`, `status='released'`,
       error set to `"Rate-limited (EX_TEMPFAIL); requeued until <ts>"`.
     - Emit a `rate_limited` event with payload:
       ```json
       { "exit_code": 75, "cooldown_until": <ts>, "reason": <stderr|stdout> }
       ```
   - Else: existing failure handling (`handleFailure`).
5. The failure-requeue path and stale-claim reclaim path must set
   `rate_limited_until = NULL` so that only rate-limit transitions leave a
   future cooldown value.

-------------------------------------------------------------------------------
Event Recording
-------------------------------------------------------------------------------
- New event kind: `rate_limited`.
- Payload shape:
  ```json
  {
    "exit_code": 75,
    "cooldown_until": 1718300000,
    "reason": "429 Too Many Requests"
  }
  ```
- Associated with the active run via `run_id`.

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
- [ ] `FF_RATE_LIMIT_EXIT_CODE=true` with a harness exiting 75 leaves the task
      in `ready`, does not change `consecutive_failures`, sets
      `rate_limited_until` to ~now+60s, and records a `rate_limited` event.
- [ ] A second tick within the cooldown window does not claim or spawn the
      rate-limited task.
- [ ] A tick after the cooldown window claims and respawns the task normally.
- [ ] `FF_RATE_LIMIT_EXIT_CODE=true KDI_RATE_LIMIT_COOLDOWN_SECONDS=300` sets
      `rate_limited_until` to ~now+300s.
- [ ] `FF_RATE_LIMIT_EXIT_CODE=true kdi dispatch --rate-limit-cooldown 2m`
      sets the cooldown to 120s.
- [ ] `FF_RATE_LIMIT_EXIT_CODE=false` with a harness exiting 75 treats it as a
      normal failure: increments `consecutive_failures` and follows
      `max_retries` circuit-breaker rules.
- [ ] `FF_RATE_LIMIT_EXIT_CODE=false kdi dispatch --rate-limit-cooldown 30s`
      exits with a clear error such as
      `"Rate-limit exit code handling is not enabled."`
- [ ] `kdi show <id>` prints `Rate limited until: <ISO8601>` when the flag is
      enabled and the cooldown is set.
- [ ] `kdi show <id>` hides the cooldown line when the flag is disabled.
- [ ] The migration is idempotent: `kdi init` against an existing DB with the
      column and index does not error.
- [ ] Unit and dispatcher integration tests cover EX_TEMPFAIL requeue,
      cooldown suppression, cooldown override, flag-disabled fallback, and
      `kdi show` display.

-------------------------------------------------------------------------------
Risks / Open Questions
-------------------------------------------------------------------------------
- **Risk:** The current dispatcher unconditionally special-cases exit 75.
  Switching it behind a feature flag changes default behavior: when
  `FF_RATE_LIMIT_EXIT_CODE=false`, exit 75 will count as a failure.
  **Mitigation:** Update the existing dispatcher test that asserts EX_TEMPFAIL
  behavior to enable `FF_RATE_LIMIT_EXIT_CODE`; add a new test for the
  flag-disabled fallback.
- **Risk:** Adding `rate_limited_until` to `tasks` requires updates to
  `TASK_COLUMNS` and `hydrateTask`; missing updates will break `showTask` /
  `listTasks`.
  **Mitigation:** Add the column to the schema, interface, column list, and
  hydration in one pass; include tests that read the task after a rate-limit
  event.
- **Risk:** A stale `rate_limited_until` value could suppress a task after it
  has been manually unblocked or reclaimed for a non-rate-limit reason.
  **Mitigation:** Clear `rate_limited_until` in `atomicClaim`, in the failure
  requeue path, in stale-claim reclaim, and in `unblockTask` when transitioning
  to `ready`/`todo`.
- **Open question:** Should the cooldown be exponential/backoff based on the
  number of consecutive rate limits? This BRD specifies a fixed cooldown to
  keep the change minimal; exponential backoff can be added later if
  operational data shows repeated 75s.
- **Open question:** Should there be a board-level or profile-level cooldown
  override? Out of scope for KDI-016c; the global default and per-invocation
  CLI option cover immediate needs.

-------------------------------------------------------------------------------
Dependencies
-------------------------------------------------------------------------------
- `src/dispatcher.ts` (tick, ready query, claim guard, exit-code handling).
- `src/models/task.ts` (schema hydration, `TASK_COLUMNS`).
- `src/models/claim.ts` (`atomicClaim` guard and clear).
- `src/commands/dispatch.ts` (`--rate-limit-cooldown` option).
- `src/commands/tasks.ts` (`kdi show` display).
- `src/flags.ts` (`FF_RATE_LIMIT_EXIT_CODE`).
- `src/db.ts` (column migration and index).
