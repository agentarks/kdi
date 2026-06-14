# BRD-KDI-020: Board Diagnostics

-------------------------------------------------------------------------------
Business Goal
-------------------------------------------------------------------------------
Give operators an automated health check for a board so they can spot
operational problems without manually inspecting every task. The `kdi
diagnostics` command runs a battery of rules against active tasks and reports
findings with severity, a human-readable message, and suggested remediation
actions.

-------------------------------------------------------------------------------
User Stories
-------------------------------------------------------------------------------
1. As an operator, I can run `kdi diagnostics` to see all health findings for
   the current board.
2. As an operator, I can filter findings by severity with
   `kdi diagnostics --severity error`.
3. As an operator, I can inspect a single task with
   `kdi diagnostics --task <task_id>`.
4. As a tooling author, I can consume findings as JSON with
   `kdi diagnostics --json`.

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------
- `kdi diagnostics [--board <slug>]` runs every diagnostic rule against the
  resolved board and prints findings.
- `kdi diagnostics --severity {warning|error|critical}` only prints findings
  whose severity is at least the requested level.
- `kdi diagnostics --task <task_id>` only runs rules against the specified
  task. The task must belong to the resolved board.
- `kdi diagnostics --json` outputs a stable JSON array of findings.
- Each finding contains:
  - `rule`: rule identifier (e.g., `stranded_in_ready`).
  - `severity`: `warning`, `error`, or `critical`.
  - `task_id`: affected task id.
  - `message`: human-readable description of the problem.
  - `actions`: array of suggested remediation actions from the set
    `reclaim`, `reassign`, `unblock`, `cli_hint`, `open_docs`, `comment`.
- Diagnostic rules cover the following conditions:
  1. `stranded_in_ready` — a `ready` task is older than a configurable age
     threshold (default 24 hours). Severity: `warning`.
  2. `stuck_in_blocked` — a `blocked` task is older than a configurable age
     threshold (default 24 hours). Severity: `warning`.
  3. `repeated_failures` — a task has `consecutive_failures` greater than or
     equal to a configurable threshold (default 3). Severity: `error`.
  4. `repeated_crashes` — a task has at least a configurable threshold of
     `task_runs` rows with `outcome = 'crashed'` (default 3). Severity:
     `error`.
  5. `block_unblock_cycling` — a task has more than a configurable threshold of
     `blocked`/`unblocked` event transitions in its event history (default 3
     cycles). Severity: `warning`.
  6. `hallucinated_cards` — a non-archived task references another task id in
     its `body` that does not exist or is archived on the same board. Severity:
     `warning`.
  7. `prose_phantom_refs` — a non-archived task references another task id in
     its `body` that belongs to a different board. Severity: `warning`.
  8. `triage_aux_unavailable` — a `triage` task has been sitting for longer
     than a configurable age threshold (default 1 hour) without a body or
     assignee to process it. Severity: `warning`.
- Rules only inspect non-archived tasks unless the rule explicitly requires
  historical data (e.g., `task_runs`, `task_events`).
- The board is resolved via the standard chain:
  `--board` flag → `KDI_BOARD` env → current-board file → `"default"`.

-------------------------------------------------------------------------------
Non-Functional Requirements
-------------------------------------------------------------------------------
- CLI response time remains sub-100ms for boards with up to 10,000 tasks.
- `kdi diagnostics --json` output is stable and parseable by external tools.
- No breaking change to other CLI commands.
- Diagnostic rules are pure queries; they never mutate task state.

-------------------------------------------------------------------------------
Feature Flag Requirements
-------------------------------------------------------------------------------
- `ff_diagnostics` registered in `src/flags.ts`:
  ```ts
  export const FF_DIAGNOSTICS = "FF_DIAGNOSTICS";
  registerFlag(FF_DIAGNOSTICS, false);
  ```
- Env var form: `FF_DIAGNOSTICS=false`.
- Defaults to `false` in every environment.
- `kdi diagnostics` is rejected when the flag is disabled.

-------------------------------------------------------------------------------
Schema Changes
-------------------------------------------------------------------------------
No schema changes are required. The feature reads from the existing `tasks`,
`task_runs`, `task_events`, and `boards` tables.

-------------------------------------------------------------------------------
CLI Surface
-------------------------------------------------------------------------------
- `kdi diagnostics [--board <slug>]` — board-wide diagnostic findings.
- `kdi diagnostics --severity {warning|error|critical} [--board <slug>]` —
  filter by minimum severity.
- `kdi diagnostics --task <task_id> [--board <slug>]` — per-task diagnostics.
- `kdi diagnostics --json` — machine-readable output.

-------------------------------------------------------------------------------
Model Behavior
-------------------------------------------------------------------------------
1. `runDiagnostics(boardSlug, options)` resolves the board slug to a board row
   and verifies it is not archived.
2. If `options.taskId` is provided, verify the task exists on the resolved
   board and pass only that task id to each rule.
3. Each rule inspects the board's active tasks and returns zero or more
   findings. Rules do not write to the database.
4. Findings are filtered by `options.severity` if provided.
5. The function returns a typed array of findings for formatting by the
   command handler.

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
- [ ] `FF_DIAGNOSTICS=true kdi diagnostics --board myproj` runs all 8 rules and
      prints findings.
- [ ] `FF_DIAGNOSTICS=true kdi diagnostics --severity error` only shows
      findings with severity `error` or `critical`.
- [ ] `FF_DIAGNOSTICS=true kdi diagnostics --task <id>` only reports findings
      for the specified task.
- [ ] `FF_DIAGNOSTICS=true kdi diagnostics --json` returns a stable JSON array.
- [ ] `FF_DIAGNOSTICS=false kdi diagnostics` exits with
      "Diagnostics feature is not enabled."
- [ ] `kdi diagnostics` for an archived or non-existent board exits with a
      clear error.
- [ ] `kdi diagnostics --task <id>` exits with a clear error when the task
      does not exist on the resolved board.
- [ ] Unit and CLI tests cover each rule, severity filtering, per-task mode,
      JSON output, and flag gating.

-------------------------------------------------------------------------------
Risks / Open Questions
-------------------------------------------------------------------------------
- **Risk:** Some rules (`hallucinated_cards`, `prose_phantom_refs`) use naive
  regex scanning of the task body and may false-positive on unrelated numeric
  text.
  **Mitigation:** document the heuristic nature and keep the severity as
  `warning`.
- **Risk:** Large event/run histories could make `block_unblock_cycling` and
  `repeated_crashes` slow.
  **Mitigation:** cap historical scans to a fixed window (e.g., last 100
  events/runs per task) and rely on indexed `task_runs.task_id` and
  `task_events.task_id` columns.
- **Open question:** Should diagnostics support auto-remediation actions? Out
  of scope for KDI-020; actions are advisory only.
- **Open question:** Should thresholds be configurable via env vars or CLI
  flags? Out of scope for the initial implementation; use sensible defaults.

-------------------------------------------------------------------------------
Dependencies
-------------------------------------------------------------------------------
- `src/models/board.ts` (board resolution / validation).
- `src/models/task.ts` (task queries, `TASK_COLUMNS`).
- `src/models/taskRun.ts` (run history for crash/failure rules).
- `src/models/taskEvent.ts` (event history for cycle rule).
- `src/commands/diagnostics.ts` (`kdi diagnostics`).
- `src/resolveBoard.ts` (board resolution chain).
- `src/flags.ts` (`FF_DIAGNOSTICS`).
