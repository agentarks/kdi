# BRD-KDI-019: Board Statistics

-------------------------------------------------------------------------------
Business Goal
-------------------------------------------------------------------------------
Give operators a quick, scriptable summary of board health and workload
without forcing them to count tasks manually. A single `kdi stats` command
surfaces per-status counts, per-assignee workload, and the age of the oldest
ready task so teams can spot bottlenecks and balance work across agents.

-------------------------------------------------------------------------------
User Stories
-------------------------------------------------------------------------------
1. As an operator, I can see how many tasks are in each status with
   `kdi stats`.
2. As an operator, I can see how many ready/running tasks each assignee owns.
3. As an operator, I can see how long the oldest ready task has been waiting.
4. As a tooling author, I can consume the same statistics as JSON with
   `kdi stats --json`.

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------
- `kdi stats [--board <slug>]` prints a human-readable summary for the resolved
  board.
- The summary includes:
  - Per-status counts for all non-archived tasks:
    `triage`, `todo`, `scheduled`, `ready`, `running`, `done`, `blocked`,
    `review`.
  - Per-assignee counts for tasks in `ready` and `running` status.
  - Oldest-ready age: seconds since the `created_at` of the oldest `ready`
    task, or `null` if no ready tasks exist.
- `kdi stats --json` outputs a JSON object with the same data:
  ```json
  {
    "board": "myproj",
    "status_counts": {
      "triage": 0,
      "todo": 3,
      "scheduled": 0,
      "ready": 2,
      "running": 1,
      "done": 5,
      "blocked": 1,
      "review": 0
    },
    "assignee_counts": {
      "opencode": 2,
      "claude": 1
    },
    "oldest_ready_age_seconds": 42
  }
  ```
- Counts reflect only non-archived tasks.
- Unassigned ready/running tasks are omitted from `assignee_counts`.
- The board is resolved via the standard chain:
  `--board` flag → `KDI_BOARD` env → current-board file → `"default"`.

-------------------------------------------------------------------------------
Non-Functional Requirements
-------------------------------------------------------------------------------
- CLI response time remains sub-100ms for boards with up to 10,000 tasks.
- `kdi stats --json` output is stable and parseable by external tools.
- No breaking change to other CLI commands.

-------------------------------------------------------------------------------
Feature Flag Requirements
-------------------------------------------------------------------------------
- `ff_stats` registered in `src/flags.ts`:
  ```ts
  export const FF_STATS = "FF_STATS";
  registerFlag(FF_STATS, false);
  ```
- Env var form: `FF_STATS=false`.
- Defaults to `false` in every environment.
- `kdi stats` is rejected when the flag is disabled.

-------------------------------------------------------------------------------
Schema Changes
-------------------------------------------------------------------------------
No schema changes are required. The feature reads from the existing `tasks`
table and uses the existing `idx_tasks_board_status` index.

-------------------------------------------------------------------------------
CLI Surface
-------------------------------------------------------------------------------
- `kdi stats [--board <slug>]` — human-readable board statistics.
- `kdi stats --json [--board <slug>]` — JSON output.

-------------------------------------------------------------------------------
Model Behavior
-------------------------------------------------------------------------------
1. `getBoardStats(boardSlug)` resolves the board slug to a board row and
   verifies it is not archived.
2. Query per-status counts:
   ```sql
   SELECT status, COUNT(*) AS count
   FROM tasks
   WHERE board_id = ? AND archived_at IS NULL
   GROUP BY status
   ```
3. Query per-assignee counts for `ready` and `running`:
   ```sql
   SELECT assignee, COUNT(*) AS count
   FROM tasks
   WHERE board_id = ? AND archived_at IS NULL
     AND status IN ('ready', 'running')
     AND assignee IS NOT NULL
   GROUP BY assignee
   ```
4. Query oldest ready task age:
   ```sql
   SELECT created_at FROM tasks
   WHERE board_id = ? AND archived_at IS NULL AND status = 'ready'
   ORDER BY created_at ASC LIMIT 1
   ```
   Compute `oldest_ready_age_seconds = now - created_at` (or `null`).
5. Return a typed stats object for formatting by the command handler.

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
- [ ] `FF_STATS=true kdi stats --board myproj` prints per-status counts,
      per-assignee counts, and oldest-ready age.
- [ ] `FF_STATS=true kdi stats` resolves the board via the standard chain.
- [ ] `FF_STATS=true kdi stats --json` returns valid JSON matching the
      documented shape.
- [ ] Per-status counts include zero-value statuses as `0` in JSON and omit or
      show `0` in human output.
- [ ] Per-assignee counts include only `ready` and `running` tasks with a
      non-null assignee.
- [ ] `oldest_ready_age_seconds` is `null` when no ready tasks exist.
- [ ] `FF_STATS=false kdi stats` exits with "Stats feature is not enabled."
- [ ] `kdi stats` for an archived or non-existent board exits with a clear
      error.
- [ ] Unit and CLI tests cover counts, JSON output, board resolution, and flag
      gating.

-------------------------------------------------------------------------------
Risks / Open Questions
-------------------------------------------------------------------------------
- **Risk:** Large boards could make the grouped queries slow without proper
  indexing.
  **Mitigation:** rely on the existing `idx_tasks_board_status` index; add
  `idx_tasks_board_status_assignee` if profiling shows a hotspot.
- **Risk:** The human-readable output format may become a de facto API for
  scripts.
  **Mitigation:** clearly document that `--json` is the stable machine-readable
  interface and the text format may change.
- **Open question:** Should stats include additional percentiles (e.g., median
  ready age)? Out of scope for KDI-019; add only the oldest-ready age.
- **Open question:** Should stats aggregate archived tasks? This BRD excludes
  archived tasks to focus on active workload.

-------------------------------------------------------------------------------
Dependencies
-------------------------------------------------------------------------------
- `src/models/board.ts` (board resolution / validation).
- `src/models/task.ts` (task queries, `TASK_COLUMNS` not required).
- `src/commands/tasks.ts` or a new `src/commands/stats.ts` (`kdi stats`).
- `src/resolveBoard.ts` (board resolution chain).
- `src/flags.ts` (`FF_STATS`).
