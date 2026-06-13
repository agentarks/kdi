# BRD-KDI-016b: Crash Grace Period

-------------------------------------------------------------------------------
Business Goal
-------------------------------------------------------------------------------
Slow-starting harnesses (e.g., those that must initialize a TUI, download a
model, or warm a language server) can take tens of seconds before their process
is fully alive. Without a grace period the dispatcher may incorrectly conclude
that the worker has crashed and reclaim the task immediately after spawn. A
30-second crash grace period lets the process start before liveness checks are
treated as authoritative.

-------------------------------------------------------------------------------
User Stories
-------------------------------------------------------------------------------
1. As a harness author with a slow-starting agent, I want the dispatcher to
   wait briefly after spawn before deciding my process has crashed.
2. As an operator, I want false crash reclaims to decrease so tasks are not
   oscillating between `running` and `ready`.
3. As a reviewer, I want crash detection to remain accurate once the grace
   period has elapsed.

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------
- After the dispatcher spawns a harness and obtains a PID, it records the spawn
  timestamp on the active `task_runs` row (e.g., `spawned_at` or by comparing
  `started_at`).
- For 30 seconds after spawn, the dispatcher must not transition the task to
  `blocked`/`crashed` solely because the PID is no longer alive.
- After the 30-second grace period expires, normal PID liveness checks apply:
  if the process is gone and the harness has not finished, the dispatcher may
  classify the run as `crashed` and reclaim/requeue the task.
- The grace period applies only to the initial spawn. Subsequent liveness polls
  (if any) use the normal rules.
- The grace period is independent of `max_runtime_seconds`; the runtime timeout
  still fires according to its own clock.

-------------------------------------------------------------------------------
Non-Functional Requirements
-------------------------------------------------------------------------------
- CLI response time remains sub-100ms.
- No change to successful harness runs or timeout behavior.
- The grace period constant is centralized so it can be tuned in one place.

-------------------------------------------------------------------------------
Feature Flag Requirements
-------------------------------------------------------------------------------
- `ff_crash_grace_period` registered in `src/flags.ts`:
  ```ts
  export const FF_CRASH_GRACE_PERIOD = "FF_CRASH_GRACE_PERIOD";
  registerFlag(FF_CRASH_GRACE_PERIOD, false);
  ```
- Env var form: `FF_CRASH_GRACE_PERIOD=false`.
- Defaults to `false` in every environment.
- When disabled, the dispatcher keeps the pre-grace behavior: PID liveness
  checks are authoritative immediately after spawn.

-------------------------------------------------------------------------------
Schema Changes
-------------------------------------------------------------------------------
- Add `spawned_at INTEGER` to `task_runs` (guarded migration in `src/db.ts`).
- Update the `TaskRun` interface and run column list in `src/models/taskRun.ts`
  to include `spawned_at`.
- Update run hydration to normalize `spawned_at` to a number or `null`.

-------------------------------------------------------------------------------
CLI Surface
-------------------------------------------------------------------------------
- No new top-level command is introduced.
- `kdi runs <task_id>` may display `spawned_at` when the flag is enabled.

-------------------------------------------------------------------------------
Dispatcher Behavior
-------------------------------------------------------------------------------
1. When `atomicClaim` creates the active run, set `task_runs.spawned_at` to the
   current Unix epoch.
2. After `spawnHarness` resolves, if a PID is available and the flag is enabled,
   store `spawned_at = now` on the active run (or reuse the claim-time value).
3. If the dispatcher performs a PID liveness probe before the harness exits
   (e.g., during a tick or a dedicated crash-check pass), skip the probe when:
   ```
   spawned_at IS NOT NULL AND (now - spawned_at) < 30
   ```
4. After the grace period has elapsed, a PID that is no longer alive and a
   harness that has not yet reported an exit is treated as crashed:
   - Finalize the active run with `outcome = 'crashed'` and
     `status = 'crashed'`.
   - Reclaim or requeue the task depending on `max_retries` policy.
   - Emit a `reclaimed` or `blocked` event with reason referencing the crash.

-------------------------------------------------------------------------------
Event Recording
-------------------------------------------------------------------------------
- Existing event kinds are reused: `reclaimed` or `blocked`.
- Payload for a post-grace crash reclaim:
  ```json
  { "reason": "Worker process died after grace period" }
  ```

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
- [ ] `FF_CRASH_GRACE_PERIOD=true` dispatcher spawns a slow-starting harness
      and does not reclaim it during the first 30 seconds even if `process.kill(pid, 0)`
      returns false.
- [ ] `FF_CRASH_GRACE_PERIOD=true` dispatcher reclaims a harness whose PID
      dies after the 30-second grace period has elapsed.
- [ ] `FF_CRASH_GRACE_PERIOD=false` dispatcher treats immediate PID death as a
      crash and reclaims/blocks the task without waiting.
- [ ] The active `task_runs` row records `spawned_at` when the flag is enabled.
- [ ] `kdi runs <task_id>` displays `spawned_at` when the flag is enabled.
- [ ] Successful harness runs and timeout behavior are unchanged when the flag
      is enabled.
- [ ] Unit/dispatcher integration tests cover grace-period protection,
      post-grace crash detection, and flag-disabled fallback.

-------------------------------------------------------------------------------
Risks / Open Questions
-------------------------------------------------------------------------------
- **Risk:** Adding `spawned_at` to `task_runs` requires updates to the run
  model, column list, and hydration; missing updates will break run display.
  **Mitigation:** update schema, interface, column list, and hydration in one
  pass; add a test that reads the run after claim.
- **Risk:** A harness that truly crashes immediately will now stay in `running`
  for up to 30 seconds, delaying queue recovery.
  **Mitigation:** keep the grace period short (30s) and document that it is a
  best-effort accommodation for slow starters, not a guaranteed recovery window.
- **Open question:** Should the grace period be configurable per profile or per
  task? Out of scope for KDI-016b; use a global 30-second constant.

-------------------------------------------------------------------------------
Dependencies
-------------------------------------------------------------------------------
- `src/dispatcher.ts` (spawn and PID liveness paths).
- `src/models/taskRun.ts` (`createRun`, run columns, hydration).
- `src/db.ts` (`spawned_at` migration).
- `src/flags.ts` (`FF_CRASH_GRACE_PERIOD`).
