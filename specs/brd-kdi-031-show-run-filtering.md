# BRD-KDI-031: `kdi show` Run Filtering

-------------------------------------------------------------------------------
Business Goal
-------------------------------------------------------------------------------
Let operators inspect a task's run history directly from `kdi show` and filter
that history by run status or outcome. This keeps the most common task
investigation workflow — "what happened to this task?" — in a single command
while still leaving `kdi runs` as the dedicated, unfiltered run-history view.

-------------------------------------------------------------------------------
User Stories
-------------------------------------------------------------------------------
1. As an operator, I can see a task's recent runs inside `kdi show`.
2. As an operator, I can filter the displayed runs to only those with a given
   `status` (e.g. `crashed`) or `outcome` (e.g. `completed`).
3. As an operator, I get a clear error if I pass only one of `--state-type` or
   `--state-name`.
4. As a tooling author, I can rely on `kdi show` run output being stable and
   parseable via `kdi show --json` (future work; this BRD gates the run
   section only).

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------
- `kdi show <task_id>` prints task details as it does today. When the feature
  flag is enabled, it additionally prints a "Runs:" section after comments and
  attachments.
- The run section lists runs for the task ordered by `started_at DESC`
  (newest first), mirroring the `kdi runs` display.
- Each listed run shows: run id, `status`, `outcome` (if set), `profile`,
  `started_at`, `ended_at` (if set), `summary` (if set), and `error` (if set).
- `kdi show <task_id> --state-type {status|outcome} --state-name VALUE`
  filters the run section to rows where the chosen column equals `VALUE`.
- Passing only `--state-type` or only `--state-name` is rejected with a clear
  error: "--state-type and --state-name must both be provided or both omitted."
- An invalid `--state-type` value is rejected with: "Invalid state type.
  Valid: status, outcome."
- When the filter matches no runs, the run section prints "No runs match the
  filter." and exits successfully.
- When the task has no runs, the run section prints "No runs found for this
  task." and exits successfully.
- The feature does not change `kdi runs`, which continues to show all runs
  unfiltered.

-------------------------------------------------------------------------------
Non-Functional Requirements
-------------------------------------------------------------------------------
- CLI response time remains sub-100ms for tasks with up to 1,000 runs.
- No breaking change to existing `kdi show` output when the flag is disabled.
- No breaking change to `kdi runs`.

-------------------------------------------------------------------------------
Feature Flag Requirements
-------------------------------------------------------------------------------
- `ff_show_run_filtering` registered in `src/flags.ts`:
  ```ts
  export const FF_SHOW_RUN_FILTERING = "FF_SHOW_RUN_FILTERING";
  registerFlag(FF_SHOW_RUN_FILTERING, false);
  ```
- Env var form: `FF_SHOW_RUN_FILTERING=false`.
- Defaults to `false` in every environment.
- `kdi show` does not display the run section and rejects `--state-type` and
  `--state-name` with "Run filtering feature is not enabled." when the flag is
  disabled.

-------------------------------------------------------------------------------
Schema Changes
-------------------------------------------------------------------------------
No schema changes are required. The feature reads from the existing
`task_runs` table and uses the existing `idx_task_runs_task_id` index.

-------------------------------------------------------------------------------
CLI Surface
-------------------------------------------------------------------------------
- `kdi show <task_id>` — show task details plus run history when flag enabled.
- `kdi show <task_id> --state-type status --state-name crashed` — show only
  runs whose `status` is `crashed`.
- `kdi show <task_id> --state-type outcome --state-name completed` — show only
  runs whose `outcome` is `completed`.

-------------------------------------------------------------------------------
Model Behavior
-------------------------------------------------------------------------------
1. `getRuns(taskId)` already returns all runs for a task ordered by
   `started_at DESC`.
2. Add `getRunsFiltered(taskId, { stateType, stateName })` in
   `src/models/taskRun.ts`:
   - Validates that `stateType` and `stateName` are both provided or both
     omitted.
   - Validates `stateType` is `"status"` or `"outcome"`.
   - Queries:
     ```sql
     SELECT ${TASK_RUN_COLUMNS}
     FROM task_runs
     WHERE task_id = ? AND ${stateType} = ?
     ORDER BY started_at DESC
     ```
   - Returns `TaskRun[]`.
3. The `kdi show` command handler uses `getRunsFiltered` when the flag is
   enabled and at least one filter option is present; otherwise it uses
   `getRuns`. It never displays the run section when the flag is disabled.

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
- [ ] `FF_SHOW_RUN_FILTERING=true kdi show 1` displays task details and a
      "Runs:" section listing all runs for the task.
- [ ] `FF_SHOW_RUN_FILTERING=true kdi show 1 --state-type status
      --state-name crashed` displays only runs whose status equals `crashed`.
- [ ] `FF_SHOW_RUN_FILTERING=true kdi show 1 --state-type outcome
      --state-name completed` displays only runs whose outcome equals
      `completed`.
- [ ] Passing only `--state-type` or only `--state-name` exits with a clear
      error.
- [ ] Passing an invalid `--state-type` exits with a clear error listing valid
      values.
- [ ] `FF_SHOW_RUN_FILTERING=true kdi show 1` for a task with no runs prints
      "No runs found for this task."
- [ ] `FF_SHOW_RUN_FILTERING=true kdi show 1 --state-type status
      --state-name completed` for a task with no matching runs prints
      "No runs match the filter."
- [ ] `FF_SHOW_RUN_FILTERING=false kdi show 1 --state-type status
      --state-name crashed` exits with "Run filtering feature is not enabled."
- [ ] `FF_SHOW_RUN_FILTERING=false kdi show 1` has unchanged output (no run
      section).
- [ ] `kdi runs 1` continues to list all runs regardless of the flag.
- [ ] Unit and CLI tests cover flag gating, filter matching, validation, and
      empty states.

-------------------------------------------------------------------------------
Risks / Open Questions
-------------------------------------------------------------------------------
- **Risk:** Displaying runs inside `kdi show` duplicates some of the output
  already provided by `kdi runs`.
  **Mitigation:** keep the run section concise and ordered newest-first; leave
  `kdi runs` as the dedicated full-history command. Future KDI-036 will add
  similar filtering to `kdi runs` for users who prefer a run-only view.
- **Risk:** A filter value that does not exist in the enum (e.g. an invalid
  status string) simply returns no results rather than erroring.
  **Mitigation:** this is consistent with the existing `kdi runs` behavior and
  with SQL equality semantics; document that unknown values produce empty
  results.
- **Open question:** Should `kdi show --json` include the filtered run list?
  Out of scope for KDI-031; the JSON surface for `kdi show` can be added
  separately once the run section stabilizes.

-------------------------------------------------------------------------------
Dependencies
-------------------------------------------------------------------------------
- `src/models/task.ts` (`showTask`).
- `src/models/taskRun.ts` (`getRuns`, new `getRunsFiltered`).
- `src/commands/tasks.ts` (`showTaskCommand`).
- `src/flags.ts` (`FF_SHOW_RUN_FILTERING`).
