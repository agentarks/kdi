# BRD-KDI-008: Per-Task Max Runtime

-------------------------------------------------------------------------------
Business Goal
-------------------------------------------------------------------------------
Allow operators to cap how long a single task harness may run, so runaway
agents, hanging network calls, or infinite loops cannot consume resources
indefinitely. The dispatcher must enforce the cap with a graceful timeout
(SIGTERM then SIGKILL) and record the outcome in the task run history.

-------------------------------------------------------------------------------
User Stories
-------------------------------------------------------------------------------
1. As an operator, I can set a per-task runtime cap when creating a task.
2. As a board administrator, I can see the configured cap in task details.
3. As a reviewer, I can see when a task was terminated for exceeding its cap
   via `kdi runs <task_id>` and `kdi show <task_id>`.

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------
- `max_runtime_seconds INTEGER` column on `tasks` stores the cap.
- `kdi create` accepts an optional `--max-runtime <duration>` argument.
- Duration syntax supports raw seconds (`300`) or suffixes (`30m`, `1h`, `2d`).
- `kdi show <id>` displays `Max runtime: <seconds>s` when the cap is set.
- The dispatcher copies the cap to the active `task_runs` row on claim.
- The dispatcher passes the cap to the harness as a timeout in milliseconds.
- On timeout the dispatcher sends SIGTERM, waits up to 5 seconds, then sends
  SIGKILL if the process is still alive.
- Timed-out runs are recorded with `outcome = timed_out` and `status = timed_out`.
- Tasks that time out are transitioned to `blocked` with a reason explaining
  the timeout.
- The feature is gated behind `ff_max_runtime` and defaults to `false`.
- When the flag is disabled, the CLI must reject `--max-runtime` with a clear
  error.
- Existing tasks and task runs created before this feature must have
  `max_runtime_seconds = NULL`.

-------------------------------------------------------------------------------
Non-Functional Requirements
-------------------------------------------------------------------------------
- CLI response time remains sub-100ms.
- No breaking change to existing `create` or `show` output when the feature
  flag is disabled.
- Migration is idempotent and does not break existing databases.

-------------------------------------------------------------------------------
Feature Flag Requirements
-------------------------------------------------------------------------------
- `ff_max_runtime` registered in `specs/feature-flags.md`.
- Env var form: `FF_MAX_RUNTIME=false`.
- Defaults to `false` in all environments.

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
- [ ] `FF_MAX_RUNTIME=true kdi create "x" --board b --max-runtime 5m`
      stores `max_runtime_seconds = 300` and returns a task ID.
- [ ] `FF_MAX_RUNTIME=true kdi show <id>` prints `Max runtime: 300s`.
- [ ] `FF_MAX_RUNTIME=true` dispatcher claims a ready task and passes a
      harness timeout equal to `max_runtime_seconds * 1000` ms.
- [ ] A harness that exceeds the timeout is terminated and the task is
      blocked with a timeout reason.
- [ ] `kdi runs <task_id>` shows a run with `status=timed_out` and
      `outcome=timed_out`.
- [ ] `FF_MAX_RUNTIME=false kdi create "x" --board b --max-runtime 30s`
      fails with "Max runtime feature is not enabled."
- [ ] Unit/e2e tests cover duration parsing, flag gating, dispatcher timeout
      propagation, and timeout outcome recording.

-------------------------------------------------------------------------------
Risks and Mitigations
-------------------------------------------------------------------------------
- Risk: A missing migration on `task_runs.max_runtime_seconds` causes every
  claim on an old database to fail.
  Mitigation: add an `ALTER TABLE task_runs ADD COLUMN max_runtime_seconds`
  migration guarded by `PRAGMA table_info(task_runs)`.
- Risk: `shell: true` in the dispatcher combined with user input elsewhere
  could be exploited.
  Mitigation: keep skill-name validation (KDI-009) and avoid interpolating
  untrusted strings into commands.

-------------------------------------------------------------------------------
Dependencies
-------------------------------------------------------------------------------
- Task model and CLI (`kdi create`, `kdi show`).
- Task runs model (`createRun`, `updateRun`).
- Dispatcher `spawnHarness` timeout support.
- Feature flag registry (`src/flags.ts`).
