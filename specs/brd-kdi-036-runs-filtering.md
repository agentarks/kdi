# BRD-KDI-036: `kdi runs` Filtering

-------------------------------------------------------------------------------
Business Goal
-------------------------------------------------------------------------------
Let operators filter a task's run history directly from `kdi runs` by run
`status` or `outcome`, instead of piping the full history through external
tools. This makes the dedicated run-history command useful for focused
investigations such as "show me every crashed run for this task" or "show me
runs that completed successfully," while keeping the unfiltered view
unchanged.

-------------------------------------------------------------------------------
User Stories
-------------------------------------------------------------------------------
1. As an operator, I can list all runs for a task with `kdi runs <task_id>`
   exactly as before.
2. As an operator, I can filter `kdi runs` output to only those runs with a
   given `status` (e.g. `crashed`) or `outcome` (e.g. `completed`).
3. As an operator, I get a clear error if I pass only one of `--state-type` or
   `--state-name`.
4. As a tooling author, I can rely on `kdi runs` output remaining stable when
   the feature flag is disabled or when no filter options are supplied.

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------
- `kdi runs <task_id>` lists all runs for the task ordered by `started_at DESC`
  (newest first), preserving the existing output format.
- `kdi runs <task_id> --state-type {status|outcome} --state-name VALUE`
  filters the listed runs to rows where the chosen column equals `VALUE`.
- Passing only `--state-type` or only `--state-name` is rejected with a clear
  error: "--state-type and --state-name must both be provided or both omitted."
- An invalid `--state-type` value is rejected with: "Invalid state type.
  Valid: status, outcome."
- When the filter matches no runs, the command prints "No runs match the
  filter." and exits successfully.
- When the task has no runs, the command prints "No runs found for this task."
  and exits successfully.
- The new options are gated by the `FF_RUNS_FILTERING` feature flag and are
  rejected with "Run filtering feature is not enabled." when the flag is
  disabled.
- Unfiltered `kdi runs <task_id>` behavior is unchanged when the flag is
  disabled or when no filter options are supplied.

-------------------------------------------------------------------------------
Non-Functional Requirements
-------------------------------------------------------------------------------
- CLI response time remains sub-100ms for tasks with up to 1,000 runs.
- No breaking change to existing `kdi runs` output when the flag is disabled
  or when filter options are omitted.
- Filtered queries must use parameterized SQL; no string interpolation of user
  input into the query text beyond the fixed column name whitelist.

-------------------------------------------------------------------------------
Feature Flag Requirements
-------------------------------------------------------------------------------
- `ff_runs_filtering` registered in `src/flags.ts`:
  ```ts
  export const FF_RUNS_FILTERING = "FF_RUNS_FILTERING";
  registerFlag(FF_RUNS_FILTERING, false);
  ```
- Env var form: `FF_RUNS_FILTERING=false`.
- Defaults to `false` in every environment.
- `kdi runs` rejects `--state-type` and `--state-name` with "Run filtering
  feature is not enabled." when the flag is disabled.

-------------------------------------------------------------------------------
Schema Changes
-------------------------------------------------------------------------------
No schema changes are required. The feature reads from the existing
`task_runs` table and uses the existing `idx_runs_task` index. Optionally add
composite indexes on `task_runs(task_id, status)` and
`task_runs(task_id, outcome)` if profiling shows filtered lookups become a
hotspot.

-------------------------------------------------------------------------------
CLI Surface
-------------------------------------------------------------------------------
- `kdi runs <task_id>` — show all runs for the task (unchanged).
- `kdi runs <task_id> --state-type status --state-name crashed` — show only
  runs whose `status` is `crashed`.
- `kdi runs <task_id> --state-type outcome --state-name completed` — show only
  runs whose `outcome` is `completed`.

-------------------------------------------------------------------------------
Model Behavior
-------------------------------------------------------------------------------
1. `getRuns(taskId)` already returns all runs for a task ordered by
   `started_at DESC`.
2. Reuse the existing `getRunsFiltered(taskId, { stateType, stateName })`
   helper from `src/models/taskRun.ts` (introduced in KDI-031):
   - Validates that `stateType` and `stateName` are both provided.
   - Validates `stateType` is `"status"` or `"outcome"`.
   - Queries:
     ```sql
     SELECT ${TASK_RUN_COLUMNS}
     FROM task_runs
     WHERE task_id = ? AND ${stateType} = ?
     ORDER BY started_at DESC
     ```
   - Returns `TaskRun[]`.
3. If `getRunsFiltered` is not yet present, add it to `src/models/taskRun.ts`
   with the same behavior.

-------------------------------------------------------------------------------
Command Handler Behavior
-------------------------------------------------------------------------------
1. Extend `listRunsCommand` in `src/commands/tasks.ts` with Commander options:
   - `--state-type <type>`: "Run state type to filter by (status|outcome)".
   - `--state-name <value>`: "Run state name to filter by".
2. Parse the task ID as today; then determine whether a filter was requested:
   - `const hasStateType = options.stateType !== undefined;`
   - `const hasStateName = options.stateName !== undefined;`
3. If either option is supplied and `FF_RUNS_FILTERING` is disabled, exit with
   "Run filtering feature is not enabled."
4. If exactly one of `hasStateType` or `hasStateName` is true, exit with
   "--state-type and --state-name must both be provided or both omitted."
5. If both filter options are supplied, call `getRunsFiltered(id, filter)`.
   Otherwise call `getRuns(id)`.
6. Preserve the current `kdi runs` output format exactly:
   - One line per run, prefixed with `Run #${run.id}: `.
   - Fields appear in the same order as today: `status`, optional `outcome`,
     optional `profile`, `started`, optional `spawned` (when
     `FF_CRASH_GRACE_PERIOD` is enabled and set), optional `ended`, optional
     `summary`, optional `metadata`, optional `error`.
7. Print the appropriate empty-state message:
   - No runs at all: "No runs found for this task."
   - Filter supplied but no matches: "No runs match the filter."

-------------------------------------------------------------------------------
Filtering Behavior and Edge Cases
-------------------------------------------------------------------------------
| Scenario | Expected behavior |
|---|---|
| `kdi runs 1` (no options) | Lists all runs for task 1, newest first, exactly as before. |
| `kdi runs 1 --state-type status --state-name crashed` | Lists only runs whose `status = 'crashed'`. |
| `kdi runs 1 --state-type outcome --state-name completed` | Lists only runs whose `outcome = 'completed'`. |
| Only `--state-type` supplied | Rejected: "--state-type and --state-name must both be provided or both omitted." |
| Only `--state-name` supplied | Rejected: "--state-type and --state-name must both be provided or both omitted." |
| Invalid `--state-type` (e.g. `phase`) | Rejected: "Invalid state type. Valid: status, outcome." |
| Filter supplied but no matches | Prints "No runs match the filter." and exits 0. |
| Task has no runs | Prints "No runs found for this task." and exits 0. |
| Flag disabled with filter options | Exits with "Run filtering feature is not enabled." |
| Flag disabled without filter options | Unfiltered behavior unchanged. |
| Unknown `--state-name` value | No error; SQL equality returns an empty result. |
| Case sensitivity | Filter values are matched case-sensitively against `task_runs.status` and `task_runs.outcome`. |
| Null outcomes | `--state-type outcome --state-name completed` does not match rows where `outcome IS NULL`. |

-------------------------------------------------------------------------------
Test Plan
-------------------------------------------------------------------------------
### Unit tests (`tests/models/taskRun.test.ts`)
- `getRunsFiltered` returns runs matching a `status` filter.
- `getRunsFiltered` returns runs matching an `outcome` filter.
- `getRunsFiltered` returns an empty array when no runs match.
- `getRunsFiltered` rejects an invalid `stateType`.
- (These tests already exist from KDI-031; ensure they remain green.)

### CLI / integration tests (`tests/commands/tasks.test.ts`)
- `FF_RUNS_FILTERING=true kdi runs <task_id> --state-type status
  --state-name crashed` displays only matching runs.
- `FF_RUNS_FILTERING=true kdi runs <task_id> --state-type outcome
  --state-name completed` displays only matching runs.
- `FF_RUNS_FILTERING=true kdi runs <task_id>` for a task with no runs prints
  "No runs found for this task."
- `FF_RUNS_FILTERING=true kdi runs <task_id> --state-type status
  --state-name completed` for a task with no matching runs prints
  "No runs match the filter."
- Passing only `--state-type` exits with the partial-pair error.
- Passing only `--state-name` exits with the partial-pair error.
- Passing an invalid `--state-type` exits with the valid-values error.
- `FF_RUNS_FILTERING=false kdi runs <task_id> --state-type status
  --state-name crashed` exits with "Run filtering feature is not enabled."
- `FF_RUNS_FILTERING=false kdi runs <task_id>` has unchanged output.
- `kdi runs <task_id>` output format is unchanged when the flag is enabled
  but no filter options are supplied.

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
- [ ] `FF_RUNS_FILTERING=true kdi runs 1` lists all runs for task 1 in the
      existing output format.
- [ ] `FF_RUNS_FILTERING=true kdi runs 1 --state-type status
      --state-name crashed` displays only runs whose status equals `crashed`.
- [ ] `FF_RUNS_FILTERING=true kdi runs 1 --state-type outcome
      --state-name completed` displays only runs whose outcome equals
      `completed`.
- [ ] Passing only `--state-type` or only `--state-name` exits with a clear
      error.
- [ ] Passing an invalid `--state-type` exits with a clear error listing valid
      values.
- [ ] `FF_RUNS_FILTERING=true kdi runs 1` for a task with no runs prints
      "No runs found for this task."
- [ ] `FF_RUNS_FILTERING=true kdi runs 1 --state-type status
      --state-name completed` for a task with no matching runs prints
      "No runs match the filter."
- [ ] `FF_RUNS_FILTERING=false kdi runs 1 --state-type status
      --state-name crashed` exits with "Run filtering feature is not enabled."
- [ ] `FF_RUNS_FILTERING=false kdi runs 1` has unchanged output.
- [ ] `kdi runs 1` with the flag enabled but no filter options behaves exactly
      as before.
- [ ] Unit and CLI tests cover flag gating, filter matching, validation, and
      empty states.
- [ ] `bun run lint`, `bun run test`, and `bun run build` pass.

-------------------------------------------------------------------------------
Risks / Open Questions
-------------------------------------------------------------------------------
- **Risk:** A filter value that does not exist in the enum (e.g. an invalid
  status string) simply returns no results rather than erroring.
  **Mitigation:** this is consistent with the existing `kdi show` run-filter
  behavior and with SQL equality semantics; document that unknown values
  produce empty results.
- **Risk:** Reusing `getRunsFiltered` from KDI-031 couples the two commands to
  the same validation logic.
  **Mitigation:** the helper is a pure query builder with no command-specific
  behavior; changes should continue to satisfy both callers' tests.
- **Open question:** Should `kdi runs` support additional filter dimensions such
  as `--profile` or date ranges? Out of scope for KDI-036; revisit if operators
  request broader filtering.
- **Open question:** Should filtered `kdi runs` support `--json` output? Out of
  scope for KDI-036; a stable JSON surface for runs can be added separately.

-------------------------------------------------------------------------------
Dependencies
-------------------------------------------------------------------------------
- `src/commands/tasks.ts` (`listRunsCommand`).
- `src/models/taskRun.ts` (`getRuns`, `getRunsFiltered`).
- `src/flags.ts` (`FF_RUNS_FILTERING`).

-------------------------------------------------------------------------------
STATUS.md Update Notes
-------------------------------------------------------------------------------
Add a new section under the feature list:

```markdown
## `kdi runs` Filtering (KDI-036) — In Progress
- [ ] BRD drafted at `specs/brd-kdi-036-runs-filtering.md`
- [ ] Feature flag `ff_runs_filtering` / `FF_RUNS_FILTERING` registered in
      `src/flags.ts` and `specs/feature-flags.md`, defaults to `false`
- [ ] `kdi runs <task_id> [--state-type {status|outcome}] [--state-name VALUE]`
      implemented
- [ ] `--state-type` and `--state-name` rejected unless both are provided
- [ ] Invalid `--state-type` rejected with valid values listed
- [ ] `kdi runs` output format unchanged when flag disabled or unfiltered
- [ ] Unit/CLI tests cover flag gating, filter matching, validation, and empty
      states
- [ ] `bun run lint`, `bun run test`, `bun run build` pass
```

Also update the Task Runs line in the Task Lifecycle section to mention the
new filter options:
```markdown
- [x] `kdi runs <task_id>` — show attempt history with optional
      `--state-type`/`--state-name` filters (KDI-036)
```
