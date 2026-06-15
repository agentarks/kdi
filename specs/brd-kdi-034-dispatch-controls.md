# BRD-KDI-034: `kdi dispatch` Failure-Limit Control

-------------------------------------------------------------------------------
Business Goal
-------------------------------------------------------------------------------
Give operators explicit, per-pass control over the dispatcher so that a single
tick stops spawning additional workers once a run of failures indicates a
likely systemic problem (misconfigured profile, bad repository state, etc.).
The existing `--max` cap is preserved unchanged; this BRD adds a
`--failure-limit` threshold that pauses spawning while leaving failed tasks to
follow their normal per-task retry / circuit-breaker lifecycle.

-------------------------------------------------------------------------------
User Stories
-------------------------------------------------------------------------------
1. As an operator, I can run `kdi dispatch --failure-limit 3` so that if three
   distinct tasks fail, crash, or fail to spawn in one pass, the dispatcher
   stops spawning additional workers and surfaces a clear warning.
2. As an operator, I want `--max <n>` to keep working exactly as it does today
   (ungated, unlimited when `0` or omitted) so that existing runbooks and
   scripts are not broken.
3. As a reviewer, I want the new `--failure-limit` option gated behind a
   feature flag so that default behavior is unchanged until the feature is
   intentionally enabled.

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------
- `kdi dispatch --max <n>` is existing behavior and is preserved as-is. `<n>`
  is a non-negative integer. `0` or omission means unlimited. It is **not**
  gated by `FF_DISPATCH_CONTROLS` and is not changed by this BRD.
- `kdi dispatch --failure-limit <n>` is the new feature. `<n>` is a positive
  integer. When the number of distinct tasks that fail, crash, or fail to
  spawn in the current pass reaches `<n>`, the dispatcher stops spawning
  additional workers for the remainder of the pass. Omission means no
  failure-limit behavior.
- A task counts toward the per-pass failure limit once per pass when any of
  the following occurs:
  - A spawn-time failure (missing board workdir, unknown profile, worktree
    creation failure, or harness command setup failure).
  - A harness execution failure with a non-zero exit code (excluding rate-limit
    exit code 75 when `FF_RATE_LIMIT_EXIT_CODE` is enabled).
  - A worker crash detected after the crash-grace period (dead PID).
- Rate-limited tasks (exit code 75) do **not** increment the per-pass failure
  counter, whether or not `FF_RATE_LIMIT_EXIT_CODE` is enabled.
- Tasks skipped because of unresolved parent dependencies or lost CAS claims
  do **not** increment the failure counter.
- When the failure limit is reached, the currently running worker is allowed to
  finish, but no additional workers are spawned in the same pass. The pass
  returns normally with the tasks processed so far.
- When `--max` is reached before all ready tasks are processed, the pass
  returns normally; remaining ready tasks are eligible in the next pass.
- The two options are combinatorial and independent: `--max` bounds spawns,
  `--failure-limit` bounds failures. Either may be supplied without the other.
- When both limits apply, whichever limit is reached first ends the spawn loop
  for that pass.

-------------------------------------------------------------------------------
Non-Functional Requirements
-------------------------------------------------------------------------------
- CLI response time remains sub-100ms before the long-running dispatcher loop
  starts.
- No breaking change to `kdi dispatch` behavior when `FF_DISPATCH_CONTROLS` is
  disabled (and `--max` behavior is unchanged regardless of the flag).
- Failure counting must not add measurable latency to the dispatch loop; it is
  maintained as an in-memory counter inside `tick()`.

-------------------------------------------------------------------------------
Feature Flag Requirements
-------------------------------------------------------------------------------
- `ff_dispatch_controls` registered in `src/flags.ts`:
  ```ts
  export const FF_DISPATCH_CONTROLS = "FF_DISPATCH_CONTROLS";
  registerFlag(FF_DISPATCH_CONTROLS, false);
  ```
- Env var form: `FF_DISPATCH_CONTROLS=false`.
- Defaults to `false` in every environment.
- `kdi dispatch --failure-limit <n>` is rejected when the flag is disabled.
- `kdi dispatch --max <n>` remains available and ungated, exactly as today.
- The existing `tick()` option `maxSpawnsPerTick` remains available internally
  for tests; the feature flag gates only the new `--failure-limit` CLI option.

-------------------------------------------------------------------------------
Schema Changes
-------------------------------------------------------------------------------
No schema changes are required. The feature uses the existing `tasks` columns
(`status`, `consecutive_failures`, `max_retries`) and existing `task_runs`
columns; no new tables or columns are introduced.

-------------------------------------------------------------------------------
CLI Surface
-------------------------------------------------------------------------------
- `kdi dispatch [--max <n>] [--failure-limit <n>] [--interval <ms>]
  [--rate-limit-cooldown <duration>]`
  - `--max <n>` — **existing option**, maximum number of workers to spawn in a
    single pass. Non-negative integer. `0` means unlimited. Ungated; preserved
    unchanged.
  - `--failure-limit <n>` — **new option**, per-pass failure threshold.
    Positive integer. When reached, stop spawning additional workers this pass.
    Gated by `FF_DISPATCH_CONTROLS`.
  - `--interval <ms>` — unchanged; dispatcher poll interval.
  - `--rate-limit-cooldown <duration>` — unchanged; gated by
    `FF_RATE_LIMIT_EXIT_CODE`.

Validation rules:
- `--max` must parse as an integer and be `>= 0`. Reject with a clear error
  otherwise. (Existing behavior preserved.)
- `--failure-limit` must parse as an integer and be `> 0`. Reject with a clear
  error otherwise.
- `--failure-limit` is rejected with a clear error when `FF_DISPATCH_CONTROLS`
  is disabled, even if the value is valid.

-------------------------------------------------------------------------------
Model / Dispatcher Changes
-------------------------------------------------------------------------------
1. Extend `TickOptions` to accept `failureLimit?: number`:
   ```ts
   export interface TickOptions {
     // ... existing fields ...
     maxSpawnsPerTick?: number;
     rateLimitCooldownSeconds?: number;
     failureLimit?: number;
   }
   ```
2. In `tick()`:
   - Initialize `let spawned = 0;` and `let failuresThisPass = 0;` before the
     ready-task loop. Keep the existing `spawned`/`maxSpawns` logic exactly
     as-is.
   - Stop conditions for the loop:
     - `spawned >= maxSpawns` (when `maxSpawns` is finite) — existing behavior.
     - `failuresThisPass >= failureLimit` (when `failureLimit` is set) — new.
   - Increment `spawned` after a worker is spawned (i.e., after the spawn
     attempt begins). Keep the existing increment behavior for successful
     spawns and for spawn-failure paths.
   - Increment `failuresThisPass` once per distinct task when any of the
     failure paths are invoked:
     - Board missing / workdir failure path.
     - Unknown profile path.
     - Worktree creation failure path.
     - Harness execution failure path (`handleFailure`).
     - Worker crash path (`handleCrash`).
   - Do **not** increment `failuresThisPass` for rate-limited tasks
     (`handleRateLimit`), successful completions, dependency skips, or lost
     claims.
3. When the failure limit is reached inside the loop:
   - Allow the current iteration to finish (cleanup, run finalization, and
     worktree removal still occur).
   - Log a warning to stderr:
     ```
     Dispatcher stopped spawning: failure limit of <n> reached this pass.
     ```
   - Write the same message to the board log via `logToBoard` when the board
     slug is known.
   - Break out of the spawn loop for the remainder of the pass.
4. When `--max` is reached, break the loop with the existing behavior; no
   additional warning is required (this is a normal cap, not an error
   condition).

-------------------------------------------------------------------------------
Events / Observability
-------------------------------------------------------------------------------
No new `task_events` kind is introduced. The failure-limit condition is
surfaced as:
- A warning line written to stderr from the dispatcher process.
- A board log entry via `logToBoard(boardSlug, message)` when the board slug
  is resolvable.

Existing events continue to be emitted as today:
- `blocked` / `reclaimed` events for circuit-breaker and retry behavior.
- `crashed` events for dead-PID detection.
- `rate_limited` events for rate-limited tasks (not counted as failures).

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
- [ ] `kdi dispatch --max 2` spawns at most two workers in a single pass when
      three or more tasks are ready, leaving the remaining ready tasks for the
      next pass (existing behavior preserved, ungated).
- [ ] `kdi dispatch --max 0` is treated as unlimited and spawns all ready tasks
      up to dependency/claim constraints (existing behavior preserved).
- [ ] `kdi dispatch` with no `--max` spawns all ready tasks (existing unlimited
      default preserved).
- [ ] `FF_DISPATCH_CONTROLS=true kdi dispatch --failure-limit 2` stops spawning
      after two distinct tasks fail/crash/spawn-fail in the same pass, emits a
      warning, and leaves the remaining ready tasks unprocessed until the next
      pass.
- [ ] `FF_DISPATCH_CONTROLS=true kdi dispatch --failure-limit 1 --max 10` stops
      after the first failure even though the spawn cap has not been reached.
- [ ] `FF_DISPATCH_CONTROLS=true kdi dispatch --failure-limit 3` with one
      failure and one rate-limited task does not stop; rate-limited tasks are
      not counted toward the failure limit.
- [ ] `FF_DISPATCH_CONTROLS=true kdi dispatch --max 2 --failure-limit 5` stops
      spawning when the spawn cap is reached, even though no failures have
      occurred.
- [ ] `FF_DISPATCH_CONTROLS=false kdi dispatch --failure-limit 2` exits with a
      clear error that dispatch controls are not enabled.
- [ ] `kdi dispatch --max 2` works when `FF_DISPATCH_CONTROLS=false` (the flag
      does not gate `--max`).
- [ ] `kdi dispatch --max -1` exits with a clear validation error (`--max` must
      be non-negative) (existing behavior preserved).
- [ ] `FF_DISPATCH_CONTROLS=true kdi dispatch --failure-limit 0` exits with a
      clear validation error (`--failure-limit` must be positive).
- [ ] `FF_DISPATCH_CONTROLS=true kdi dispatch --failure-limit xyz` exits with a
      clear validation error (must be an integer).
- [ ] `FF_DISPATCH_CONTROLS=true kdi dispatch --failure-limit -2` exits with a
      clear validation error (must be positive).
- [ ] The per-task `max_retries` circuit breaker continues to work unchanged
      when `--failure-limit` is in use (e.g., a task with `max_retries=2` is
      requeued once and blocked on the second failure, independent of the
      pass-level failure counter).
- [ ] Unit and dispatcher integration tests cover happy-path capping,
      failure-limit early exit, zero/invalid inputs, flag gating of
      `--failure-limit`, and interaction with `--max`.

-------------------------------------------------------------------------------
Out of Scope
-------------------------------------------------------------------------------
- Persistent per-board failure counters or rolling-window failure rates.
- Automatic task blocking based on the pass-level failure limit (only spawning
  is paused; existing per-task `max_retries` logic still governs task state).
- Changes to the long-running dispatcher mode or daemonization.
- Changes to the `--interval` or `--rate-limit-cooldown` options.
- New `task_events` kinds or database schema changes.
- Board-level diagnostics or health rules based on dispatch controls.

-------------------------------------------------------------------------------
Risks / Open Questions
-------------------------------------------------------------------------------
- **Note:** `--max` is pre-existing and ungated. This BRD does not change its
  behavior or add a feature flag around it. Any references in earlier drafts to
  gating `--max` are incorrect.
- **Risk:** The interaction between `--failure-limit` and per-task
  `max_retries` may surprise operators: a task can be blocked by its own
  circuit breaker before the pass-level limit is reached, or the pass can stop
  before a task reaches its personal retry limit.
  **Mitigation:** Document clearly that `--failure-limit` pauses spawning only
  and does not alter per-task retry behavior.
- **Open question:** Should the failure-limit warning also be emitted as a
  board-level `task_events` row (e.g., with a synthetic `task_id` or a new
  board-level events table)? Out of scope for KDI-034; revisit if operators
  need audit history for dispatcher decisions.
- **Open question:** Should `--failure-limit` be configurable via an
  environment variable (e.g., `KDI_DISPATCH_FAILURE_LIMIT`)? Out of scope; the
  CLI option is the primary interface for this BRD.

-------------------------------------------------------------------------------
Dependencies
-------------------------------------------------------------------------------
- `src/flags.ts` (`FF_DISPATCH_CONTROLS` registration; `--max` remains
  ungated).
- `src/commands/dispatch.ts` (add `--failure-limit` option parsing and
  validation; gate only `--failure-limit`; leave `--max` unchanged).
- `src/dispatcher.ts` (`tick()` spawn/failure counting and early-exit logic;
  keep existing `maxSpawns`/`spawned` behavior).
- `src/observability.ts` (`logToBoard` for failure-limit warning).
- `src/models/task.ts` (existing `max_retries` / `consecutive_failures`
  helpers).
