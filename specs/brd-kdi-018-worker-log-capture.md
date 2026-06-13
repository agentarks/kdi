# BRD-KDI-018: Worker Log Capture

-------------------------------------------------------------------------------
Business Goal
-------------------------------------------------------------------------------
Capture the stdout and stderr of every harness run to a per-task log file so
operators can debug failures, inspect agent output, and audit completed work
without re-running the harness. Provide a simple CLI to stream or tail the
most recent log.

-------------------------------------------------------------------------------
User Stories
-------------------------------------------------------------------------------
1. As an operator, I can view the combined stdout/stderr of a task run with
   `kdi log <task_id>`.
2. As an operator, I can view only the last N bytes of a log with
   `kdi log <task_id> --tail 100`.
3. As a harness author, I want my agent's output persisted automatically so
   crashes and failures are recoverable after the process exits.
4. As a reviewer, I can correlate a task's log file path with its run history.

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------
- The dispatcher writes harness stdout and stderr to
  `~/.local/share/kdi/logs/<board_slug>/<task_id>.log`.
- Log directory is created on demand with `mkdir -p` semantics.
- The log file is opened in append mode when the harness starts and closed when
  the harness exits.
- `kdi log <task_id>` prints the full log content if the file exists; if no
  log exists, it prints "No log found for this task." and exits 0.
- `kdi log <task_id> --tail <bytes>` prints only the last `<bytes>` bytes of
  the log. Values must be positive integers.
- Log capture is best-effort: failures to write the log file must not cause
  the task to fail.
- When a task is re-run (new run), the dispatcher appends to the same log file.
  A future enhancement may rotate logs; KDI-018 does not introduce log rotation.
- `kdi show <id>` may display `Log:` with the log file path when the flag is
  enabled.

-------------------------------------------------------------------------------
Non-Functional Requirements
-------------------------------------------------------------------------------
- CLI response time remains sub-100ms for logs under 10 MiB.
- Log writes must not block the dispatcher event loop.
- No breaking change to existing dispatcher behavior when the feature flag is
  disabled.

-------------------------------------------------------------------------------
Feature Flag Requirements
-------------------------------------------------------------------------------
- `ff_worker_log_capture` registered in `src/flags.ts`:
  ```ts
  export const FF_WORKER_LOG_CAPTURE = "FF_WORKER_LOG_CAPTURE";
  registerFlag(FF_WORKER_LOG_CAPTURE, false);
  ```
- Env var form: `FF_WORKER_LOG_CAPTURE=false`.
- Defaults to `false` in every environment.
- Log capture in the dispatcher and `kdi log` are rejected/hidden when the flag
  is disabled.

-------------------------------------------------------------------------------
Schema Changes
-------------------------------------------------------------------------------
No schema changes are required. The log path is derived from the board slug and
 task ID at runtime.

-------------------------------------------------------------------------------
CLI Surface
-------------------------------------------------------------------------------
- `kdi log <task_id>` — print the captured log.
- `kdi log <task_id> --tail <bytes>` — print the last N bytes.
- `kdi show <id>` — optionally displays the log path when the flag is enabled.

-------------------------------------------------------------------------------
Dispatcher Behavior
-------------------------------------------------------------------------------
1. Before spawning the harness, resolve the log path via
   `getTaskLogPath(boardSlug, task.id)` and ensure the parent directory exists.
2. Pass the log path to `spawnHarness`.
3. `spawnHarness` opens a writable stream to the log path and writes every
   stdout/stderr chunk to it as it arrives.
4. On harness exit or error, close the stream. Exceptions during log writes are
   swallowed so they do not affect harness result handling.
5. When the flag is disabled, `spawnHarness` receives `logPath = undefined` and
   no log file is created.

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
- [ ] `FF_WORKER_LOG_CAPTURE=true` dispatcher creates
      `~/.local/share/kdi/logs/<board>/<task_id>.log` and writes combined
      stdout/stderr to it.
- [ ] `FF_WORKER_LOG_CAPTURE=true kdi log <task_id>` prints the full log
      content.
- [ ] `FF_WORKER_LOG_CAPTURE=true kdi log <task_id> --tail 100` prints the
      last 100 bytes.
- [ ] `FF_WORKER_LOG_CAPTURE=true kdi log <task_id>` on a task with no log
      prints "No log found for this task."
- [ ] `FF_WORKER_LOG_CAPTURE=true kdi log <task_id> --tail -1` exits with a
      clear validation error.
- [ ] `FF_WORKER_LOG_CAPTURE=false kdi log <task_id>` exits with
      "Worker log capture is not enabled."
- [ ] `FF_WORKER_LOG_CAPTURE=false` dispatcher does not create per-task log
      files.
- [ ] Log-write failures do not cause the dispatcher to fail the task.
- [ ] Unit and dispatcher integration tests cover log creation, `--tail`
      behavior, missing log handling, and flag gating.

-------------------------------------------------------------------------------
Risks / Open Questions
-------------------------------------------------------------------------------
- **Risk:** Long-running harnesses can produce multi-gigabyte logs, consuming
  disk and slowing `kdi log`.
  **Mitigation:** defer log rotation to a future BRD; for KDI-018, document
  that operators should monitor disk usage.
- **Risk:** Log files may contain sensitive output (tokens, environment vars).
  **Mitigation:** store logs in the user's home directory with standard
  permissions; advise harness authors to redact secrets.
- **Risk:** The existing dispatcher already captures logs without a feature
  flag. Adding a flag changes default behavior: when disabled, no logs are
  written.
  **Mitigation:** update existing dispatcher tests that inspect log files to
  enable `FF_WORKER_LOG_CAPTURE`; add a flag-disabled test.
- **Open question:** Should logs be scoped per run rather than per task?
  This BRD scopes by task for simplicity; per-run logs can be added later.

-------------------------------------------------------------------------------
Dependencies
-------------------------------------------------------------------------------
- `src/observability.ts` (`getTaskLogPath`).
- `src/dispatcher.ts` (`spawnHarness` log streaming).
- `src/commands/tasks.ts` (`kdi log` command).
- `src/flags.ts` (`FF_WORKER_LOG_CAPTURE`).
