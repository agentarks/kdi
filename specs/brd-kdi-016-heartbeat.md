# BRD-KDI-016: Heartbeat

-------------------------------------------------------------------------------
Business Goal
-------------------------------------------------------------------------------
Provide a lightweight worker liveness signal so the dispatcher can distinguish
between a healthy long-running harness and a dead or stuck one. Heartbeats let
agents announce progress during a task, and the dispatcher uses the last
heartbeat time to reclaim tasks whose workers have gone silent.

-------------------------------------------------------------------------------
User Stories
-------------------------------------------------------------------------------
1. As a harness author, I can emit `kdi heartbeat <task_id>` from inside my
   agent wrapper so the dispatcher knows the worker is still alive.
2. As a harness author, I can attach a short note to a heartbeat so operators
   can see coarse progress when tailing task events.
3. As an operator, I want the dispatcher to auto-reclaim a task whose worker
   has not heartbeated within a defined window, so stale claims do not block
   the queue indefinitely.
4. As a reviewer, I can see the last heartbeat timestamp on a running task via
   `kdi show`.

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------
- `kdi heartbeat <task_id>` updates `tasks.last_heartbeat_at` and the active
  `task_runs.last_heartbeat_at` (when `tasks.current_run_id` is set) to the
  current Unix epoch.
- `kdi heartbeat <task_id> --note "..."` stores the note in a `heartbeat`
  event payload and updates the heartbeat timestamps.
- The command is rejected with a clear error when the task does not exist or is
  archived.
- The dispatcher records an initial heartbeat immediately after a successful
  `atomicClaim` so a freshly claimed task is not instantly considered stale.
- The dispatcher's stale-claim reaper treats a running task as reclaimable when
  either:
  - `claim_expires < now` (claim TTL exceeded), or
  - `last_heartbeat_at` is set and older than 60 minutes.
- A task with `last_heartbeat_at IS NULL` is reaped only by `claim_expires`.
- On reclaim, the active `task_runs` row is finalized with
  `outcome = 'reclaimed'` and `status = 'released'`, and a `reclaimed` event is
  recorded with reason `"stale heartbeat detected by dispatcher"`.
- `kdi show <id>` displays `Last heartbeat: <ISO8601>` when the task is in
  `running` status and a heartbeat has been recorded.

-------------------------------------------------------------------------------
Non-Functional Requirements
-------------------------------------------------------------------------------
- CLI response time remains sub-100ms.
- Heartbeat event payload is capped at 4 KiB to avoid runaway storage.
- No breaking change to `kdi show` output when the feature flag is disabled.

-------------------------------------------------------------------------------
Feature Flag Requirements
-------------------------------------------------------------------------------
- `ff_heartbeat` registered in `src/flags.ts`:
  ```ts
  export const FF_HEARTBEAT = "FF_HEARTBEAT";
  registerFlag(FF_HEARTBEAT, false);
  ```
- Env var form: `FF_HEARTBEAT=false`.
- Defaults to `false` in every environment.
- `kdi heartbeat` is rejected when the flag is disabled.
- Dispatcher heartbeat-aware stale-claim reaping is disabled when the flag is
  disabled (only `claim_expires` reaping runs).
- `kdi show` hides the `Last heartbeat:` line when the flag is disabled.

-------------------------------------------------------------------------------
Schema Changes
-------------------------------------------------------------------------------
No schema changes are required. The following columns already exist and are
used by this feature:
- `tasks.last_heartbeat_at INTEGER`
- `tasks.current_run_id INTEGER`
- `task_runs.last_heartbeat_at INTEGER`

-------------------------------------------------------------------------------
CLI Surface
-------------------------------------------------------------------------------
- `kdi heartbeat <task_id> [--note <text>]` — emit a worker liveness signal.
- `kdi show <id>` — displays the last heartbeat when the flag is enabled and
  the task is running.

-------------------------------------------------------------------------------
Dispatcher Behavior
-------------------------------------------------------------------------------
1. After a successful `atomicClaim`, call `heartbeat(task.id)` to seed the
   initial timestamp.
2. In `reapStaleClaims`, add the heartbeat condition only when
   `FF_HEARTBEAT=true`:
   ```sql
   SELECT id, current_run_id FROM tasks
   WHERE status = 'running'
     AND (
       claim_expires < ?
       OR (last_heartbeat_at IS NOT NULL AND last_heartbeat_at < ?)
     )
   ```
   where the heartbeat threshold is `now - 3600`.
3. Finalize the active run and emit a `reclaimed` event for each stale task,
   then transition the task back to `ready` with `claim_lock`,
   `claim_expires`, `started_at`, and `current_run_id` cleared.

-------------------------------------------------------------------------------
Event Recording
-------------------------------------------------------------------------------
- Existing event kind: `heartbeat`.
- Payload shape when `--note` is provided:
  ```json
  { "note": "parsed requirements, starting implementation" }
  ```
- When no note is provided, the event payload is `{}`.
- Existing event kind: `reclaimed`.
- Payload shape for stale-heartbeat reclaim:
  ```json
  { "reason": "stale heartbeat detected by dispatcher" }
  ```

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
- [ ] `FF_HEARTBEAT=true kdi heartbeat 42` updates `tasks.last_heartbeat_at`
      and the active run's `last_heartbeat_at` to the current time.
- [ ] `FF_HEARTBEAT=true kdi heartbeat 42 --note "step 1 done"` records a
      `heartbeat` event with the note and updates both timestamps.
- [ ] `FF_HEARTBEAT=true kdi show 42` on a running task prints
      `Last heartbeat: <ISO8601>`.
- [ ] A running task whose `last_heartbeat_at` is older than 60 minutes is
      reclaimed by the next dispatcher tick and returned to `ready`.
- [ ] A running task with `last_heartbeat_at IS NULL` is reaped only when its
      `claim_expires` timestamp has passed.
- [ ] `FF_HEARTBEAT=false kdi heartbeat 42` exits with
      "Heartbeat feature is not enabled."
- [ ] `FF_HEARTBEAT=false` dispatcher reaps only by `claim_expires`; heartbeat
      age is ignored.
- [ ] Unit and dispatcher integration tests cover heartbeat timestamp updates,
      stale-heartbeat reclaim, flag gating, and `kdi show` display.

-------------------------------------------------------------------------------
Risks / Open Questions
-------------------------------------------------------------------------------
- **Risk:** The existing dispatcher and CLI already implement heartbeat logic
  without a feature flag. Enabling the flag by default will change behavior and
  may require updating existing tests.
  **Mitigation:** Add `FF_HEARTBEAT=true` to existing heartbeat/dispatcher
  tests; add a new test for the flag-disabled fallback.
- **Risk:** A burst of heartbeats from a chatty harness could flood
  `task_events`.
  **Mitigation:** cap the optional note at 4 KiB and rely on the harness author
  to heartbeat at a reasonable cadence (e.g., every 30–300s).
- **Open question:** Should the 60-minute stale threshold be configurable via
  env var or CLI option? Out of scope for KDI-016; hard-code 60 minutes and
  revisit if operational data shows it is too aggressive or too lenient.

-------------------------------------------------------------------------------
Dependencies
-------------------------------------------------------------------------------
- `src/models/claim.ts` (`heartbeat` model function).
- `src/commands/tasks.ts` (`kdi heartbeat` command wiring).
- `src/dispatcher.ts` (initial heartbeat on claim, stale-claim reaper).
- `src/models/task.ts` (`showTask` / `TASK_COLUMNS` — no new columns).
- `src/flags.ts` (`FF_HEARTBEAT`).
