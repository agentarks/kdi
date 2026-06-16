# BRD-KDI-030: `kdi list` Filters and Sort

-------------------------------------------------------------------------------
Business Goal
-------------------------------------------------------------------------------
Give operators flexible ways to find and order tasks on a board. A mature
Kanban CLI must support common filters (my tasks, archived tasks, originating
session) and stable sort orders beyond the default "newest first". This
reduces the need to pipe `kdi list` into external tools and brings KDI closer
to parity with the Hermes Kanban `list` command surface.

-------------------------------------------------------------------------------
User Stories
-------------------------------------------------------------------------------
1. As an operator, I can list only tasks assigned to me with
   `kdi list --mine`.
2. As an operator, I can include archived tasks in a listing with
   `kdi list --archived`.
3. As an orchestrator, I can list tasks created by a specific agent session
   with `kdi list --session <session_id>`.
4. As an operator, I can sort listings by assignee, priority, status, title,
   creation time, or last update using `kdi list --sort <key>`.
5. As a workflow author, I can filter a listing by workflow template and step
   key with `kdi list --workflow-template-id <id> --step-key <key>` (columns
   are added here; template-driven routing remains KDI-039).

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------
- `kdi list` continues to resolve the board via the standard chain:
  `--board` → `KDI_BOARD` env → current file → `default`.
- Existing filters (`--status`, `--assignee`, `--tenant`, `--created-by`)
  continue to work and compose with the new filters.
- `--mine` is a shortcut for `--assignee <current profile>`. The current
  profile is resolved from `KDI_PROFILE`, then `HERMES_PROFILE`, then
  `"user"`. Resolution happens in the command handler (or a shared CLI
  helper) and the resolved profile is passed to `listTasks` as `assignee`.
  Passing both `--mine` and `--assignee <profile>` is an error.
- `--archived` removes the default `archived_at IS NULL` filter and includes
  archived tasks. `--status archived` is only allowed when `--archived` is
  also passed and `FF_LIST_FILTERS_SORT` is enabled; otherwise it is rejected
  by the existing `VALID_STATUSES` validation.
- `--sort <key>` orders results before printing. Valid keys:
  - `assignee` — assignee ASC, NULLs last, then id ASC
  - `created` — created_at ASC, then id ASC
  - `created-desc` — created_at DESC, then id DESC (current default)
  - `priority` — priority DESC, then created_at ASC
  - `priority-desc` — alias for `priority`
  - `status` — status ASC, then id ASC
  - `title` — title ASC (case-insensitive), then id ASC
  - `updated` — updated_at DESC, then id DESC
- `--workflow-template-id <id>` filters by `tasks.workflow_template_id`.
- `--step-key <key>` filters by `tasks.current_step_key`. May be combined with
  `--workflow-template-id`.
- `kdi create --session <session_id>` stores the originating session id on the
  task. This option is gated by the same feature flag because `--session`
  filtering is otherwise useless.
- All new list options are rejected with a clear error when the feature flag is
  disabled.
- Invalid sort keys are rejected with a list of valid values.

-------------------------------------------------------------------------------
Non-Functional Requirements
-------------------------------------------------------------------------------
- CLI response time remains sub-100ms for boards with 10,000 non-archived
  tasks.
- Sorting and filtering are pushed to SQLite; do not load the full task set
  into memory to sort.
- Any new indexes added to support sorting must be board-scoped (prefix
  `board_id`) because every list query filters by `board_id`.
- No breaking change to default `kdi list` output shape when the flag is
  disabled.

-------------------------------------------------------------------------------
Feature Flag Requirements
-------------------------------------------------------------------------------
- `ff_list_filters_sort` registered in `src/flags.ts`:
  ```ts
  export const FF_LIST_FILTERS_SORT = "FF_LIST_FILTERS_SORT";
  registerFlag(FF_LIST_FILTERS_SORT, false);
  ```
- Env var form: `FF_LIST_FILTERS_SORT=false`.
- Defaults to `false` in every environment.
- Gated surfaces:
  - `kdi list --mine`
  - `kdi list --session <session_id>`
  - `kdi list --archived`
  - `kdi list --sort <key>`
  - `kdi list --workflow-template-id <id>`
  - `kdi list --step-key <key>`
  - `kdi create --session <session_id>`

-------------------------------------------------------------------------------
Schema Changes
-------------------------------------------------------------------------------
Add three TEXT columns to the `tasks` table with supporting indexes. Use the
existing `PRAGMA table_info(tasks)` guard pattern so migrations are safe on
both fresh and existing databases:

```ts
const tableInfo = db.query("PRAGMA table_info(tasks)").all() as any[];
if (!tableInfo.some((col) => col.name === "session_id")) {
  dbInstance.exec("ALTER TABLE tasks ADD COLUMN session_id TEXT");
}
if (!tableInfo.some((col) => col.name === "workflow_template_id")) {
  dbInstance.exec("ALTER TABLE tasks ADD COLUMN workflow_template_id TEXT");
}
if (!tableInfo.some((col) => col.name === "current_step_key")) {
  dbInstance.exec("ALTER TABLE tasks ADD COLUMN current_step_key TEXT");
}

// Supporting indexes (board-scoped because every list query includes board_id)
dbInstance.exec(`
  CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(board_id, session_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_workflow_template ON tasks(board_id, workflow_template_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_step_key ON tasks(board_id, current_step_key);
`);
```

Update the baseline `tasks` schema to include the new columns so fresh
databases create them directly.

Update `TASK_COLUMNS`, the `Task` interface, `CreateTaskInput`, and
`hydrateTask` to include the new fields.

**Note on `current_step_key` vs. `task_runs.step_key`:** `task_runs.step_key`
captures the step at which a run was attempted. `tasks.current_step_key` is
the task's current routing step for v2 workflow templates (KDI-039). This BRD
adds the column only to support list filtering; KDI-039 owns step advancement
semantics.

-------------------------------------------------------------------------------
CLI Surface
-------------------------------------------------------------------------------
- `kdi list [--board <slug>] [--status <status>] [--assignee <profile>]
  [--tenant <name>] [--created-by <actor>] [--mine] [--session <session_id>]
  [--archived] [--sort <key>] [--workflow-template-id <id>]
  [--step-key <key>]`
- `kdi create <title> ... [--session <session_id>]` (new option, gated).

-------------------------------------------------------------------------------
Model Behavior
-------------------------------------------------------------------------------
1. Extend `ListTasksFilter`:
   ```ts
   export interface ListTasksFilter {
     board_id: number;
     status?: Task["status"];
     assignee?: string;
     tenant?: string;
     created_by?: string;
     includeArchived?: boolean;
     session_id?: string;
     workflow_template_id?: string;
     current_step_key?: string;
   }
   ```
2. `listTasks(filter, sort?)`:
   - Build the WHERE clause from all supplied filters.
   - Default `archived_at IS NULL` unless `includeArchived` is true.
   - Apply `ORDER BY` according to the sort key; reject unknown sort keys
     with a clear error listing valid values.
   - The command handler resolves `--mine` to a profile and passes it as
     `filter.assignee`; the model layer does not read `process.env`.
   - Return hydrated tasks.
3. `createTask(input)`:
   - Persist `session_id`, `workflow_template_id`, and `current_step_key` when
     provided.

-------------------------------------------------------------------------------
Event Recording
-------------------------------------------------------------------------------
No new event kinds. `created` event payload is unchanged.

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
- [ ] `FF_LIST_FILTERS_SORT=true kdi create "task" --board myproj --session
      sess-123` stores `session_id = "sess-123"`.
- [ ] `FF_LIST_FILTERS_SORT=true kdi list --board myproj --session sess-123`
      returns only tasks with that session id.
- [ ] `FF_LIST_FILTERS_SORT=true KDI_PROFILE=alice kdi list --board myproj
      --mine` returns only tasks assigned to `alice`.
- [ ] `FF_LIST_FILTERS_SORT=true kdi list --board myproj --archived` includes
      tasks whose `archived_at` is set.
- [ ] `FF_LIST_FILTERS_SORT=true kdi list --board myproj --status archived
      --archived` returns only archived tasks.
- [ ] `FF_LIST_FILTERS_SORT=true kdi list --board myproj --sort priority`
      returns tasks ordered by priority DESC, oldest first as a tiebreaker.
- [ ] `FF_LIST_FILTERS_SORT=true kdi list --board myproj --sort title`
      returns tasks ordered case-insensitively by title.
- [ ] `FF_LIST_FILTERS_SORT=true kdi list --board myproj --sort updated`
      returns tasks ordered by `updated_at` DESC.
- [ ] `FF_LIST_FILTERS_SORT=true kdi list --board myproj
      --workflow-template-id onboarding` returns only matching tasks.
- [ ] `FF_LIST_FILTERS_SORT=true kdi list --board myproj --step-key review`
      returns only matching tasks.
- [ ] New filters compose with existing `--status`, `--assignee`, `--tenant`,
      and `--created-by` filters.
- [ ] `FF_LIST_FILTERS_SORT=true kdi list --board myproj --mine --assignee
      bob` exits with a clear error that `--mine` and `--assignee` cannot be
      used together.
- [ ] `FF_LIST_FILTERS_SORT=false kdi list --mine` exits with "List filters
      and sort feature is not enabled."
- [ ] `FF_LIST_FILTERS_SORT=false kdi create "task" --session sess-123`
      exits with the same gating error.
- [ ] `kdi list --sort invalid` exits with a list of valid sort keys.
- [ ] Unit and CLI tests cover each new filter, each sort key, flag gating,
      and composition with existing filters.

-------------------------------------------------------------------------------
Risks / Open Questions
-------------------------------------------------------------------------------
- **Risk:** Adding `workflow_template_id` and `current_step_key` columns in a
  CLI-polish BRD overlaps with KDI-039 (Workflow templates), which owns the
  routing semantics for step keys.
  **Mitigation:** This BRD only adds the columns and list filters; it does
  not implement workflow routing or step advancement. KDI-039 will reuse these
  columns and may extend them. Open question below asks whether to defer those
  two filters entirely.
- **Risk:** `--mine` relies on environment variables that may differ between
  the shell that created the task and the shell that lists it.
  **Mitigation:** document that `--mine` resolves the caller's current profile
  at list time; it is not a stored property.
- **Risk:** Case-insensitive `title` sorting requires SQLite collation support
  (`COLLATE NOCASE`). Bun's SQLite build supports this, but verify in CI.
  **Mitigation:** add a unit test for mixed-case title sorting.
- **Open question:** Should `--workflow-template-id` and `--step-key` be
  deferred to KDI-039 to avoid adding v2 schema in a Phase 7 CLI-polish item?
  The backlog includes them under KDI-030, but they have no value until KDI-039
  populates the columns.
- **Open question:** Should `create --session` be gated independently? The
  current design uses the same flag for both create and list because the filter
  depends on the option.
- **Open question:** Should archived tasks be excluded from `--sort` tiebreaker
  ordering, or should archived tasks interleave with active tasks when
  `--archived` is used? Current proposal: no special handling; archived tasks
  sort by the chosen key like any other task.

-------------------------------------------------------------------------------
Dependencies
-------------------------------------------------------------------------------
- `src/models/task.ts` (`listTasks`, `createTask`, `Task`, `TASK_COLUMNS`,
  `hydrateTask`).
- `src/commands/tasks.ts` (`kdi list`, `kdi create`; current-profile
  resolution for `--mine`).
- `src/db.ts` (schema + migration for new columns and indexes).
- `src/flags.ts` (`FF_LIST_FILTERS_SORT`).
- `specs/feature-flags.md` (registry entry for `ff_list_filters_sort`).
