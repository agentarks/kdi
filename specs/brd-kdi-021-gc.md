# BRD-KDI-021: Garbage Collection

-------------------------------------------------------------------------------
Business Goal
-------------------------------------------------------------------------------
Give operators a safe, explicit command to reclaim disk space used by aging
audit data and artifacts. `kdi gc` removes old task events, old worker logs,
and KDI-owned workspaces left behind by archived tasks.

-------------------------------------------------------------------------------
User Stories
-------------------------------------------------------------------------------
1. As an operator, I can prune task events older than N days with
   `kdi gc --event-retention-days N`.
2. As an operator, I can prune captured worker logs older than N days with
   `kdi gc --log-retention-days N`.
3. As an operator, I can clean up KDI-owned workspaces belonging to archived
   tasks by running `kdi gc`.
4. As an operator, I can target a specific board with `--board` or rely on the
   standard board-resolution chain.

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------
- `kdi gc [--board <slug>] [--event-retention-days <n>] [--log-retention-days <n>]`
  runs garbage collection for the resolved board.
- The board is resolved via the standard chain:
  `--board` flag → `KDI_BOARD` env → current-board file → `"default"`.
- The board must exist and must not be archived.
- `--event-retention-days`, when provided, deletes `task_events` rows whose
  `created_at` is older than `now - (n * 86400)` for tasks on the board.
- `--log-retention-days`, when provided, deletes log files under
  `~/.local/share/kdi/logs/<boardSlug>/` whose modification time is older than
  the retention cutoff.
- Archived-task workspace cleanup runs unconditionally and removes KDI-owned
  workspace directories belonging to tasks in `archived` status on the board.
  A path is considered KDI-owned only if it resides under the board data
  directory (`~/.local/share/kdi/boards/<slug>/`) or under the system temp
  directory with a `kdi-` prefix.
- Workspace cleanup clears the `workspace` column on the task row after a
  successful deletion so the same directory is not re-targeted.
- The command prints a human-readable summary:
  ```
  Garbage collection complete for board <slug>.
    Deleted events: <n>
    Deleted logs: <n>
    Cleaned archived workspaces: <n>
  ```

-------------------------------------------------------------------------------
Non-Functional Requirements
-------------------------------------------------------------------------------
- GC must never delete user-provided workspace paths (e.g. a board workdir or
  `--workspace` directory outside KDI-managed paths).
- Log and event deletions are bounded by the provided retention days.
- CLI response time remains sub-100ms for boards with up to 10,000 events.
- No breaking change to other CLI commands.

-------------------------------------------------------------------------------
Feature Flag Requirements
-------------------------------------------------------------------------------
- `ff_gc` registered in `src/flags.ts`:
  ```ts
  export const FF_GC = "FF_GC";
  registerFlag(FF_GC, false);
  ```
- Env var form: `FF_GC=false`.
- Defaults to `false` in every environment.
- `kdi gc` is rejected when the flag is disabled.

-------------------------------------------------------------------------------
Schema Changes
-------------------------------------------------------------------------------
No schema changes are required. The feature reads and deletes from the existing
`tasks`, `task_events`, and `boards` tables and removes files from the existing
log directory layout.

-------------------------------------------------------------------------------
CLI Surface
-------------------------------------------------------------------------------
- `kdi gc [--board <slug>] [--event-retention-days <n>] [--log-retention-days <n>]`
  — run garbage collection.

-------------------------------------------------------------------------------
Model Behavior
-------------------------------------------------------------------------------
1. `runGarbageCollection(boardSlug, options)` resolves the board slug to a board
   row and verifies it is not archived.
2. If `--event-retention-days` is provided and positive:
   ```sql
   DELETE FROM task_events
   WHERE task_id IN (SELECT id FROM tasks WHERE board_id = ?)
     AND created_at < ?
   ```
   where the cutoff is `unixepoch() - (days * 86400)`. Return `changes`.
3. If `--log-retention-days` is provided and positive:
   - List files in `~/.local/share/kdi/logs/<boardSlug>/`.
   - Delete files whose `mtimeMs` is before the cutoff.
   - Return the count of deleted files.
4. Archived-task workspace cleanup:
   - Query `SELECT id, workspace, workspace_kind FROM tasks WHERE board_id = ?
     AND status = 'archived' AND workspace IS NOT NULL`.
   - For each workspace path, determine whether it is KDI-owned.
   - If KDI-owned and the path exists, delete it recursively and update the
     task row to set `workspace = NULL`.
   - Return the count of cleaned workspaces.
5. Return a typed result object for formatting by the command handler.

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
- [ ] `FF_GC=true kdi gc --board myproj --event-retention-days 30` deletes
      task events older than 30 days and reports the count.
- [ ] `FF_GC=true kdi gc --board myproj --log-retention-days 7` deletes worker
      logs older than 7 days and reports the count.
- [ ] `FF_GC=true kdi gc --board myproj` cleans KDI-owned workspaces for
      archived tasks and reports the count.
- [ ] `FF_GC=true kdi gc` resolves the board via the standard chain.
- [ ] `FF_GC=false kdi gc` exits with "GC feature is not enabled."
- [ ] `kdi gc` for an archived or non-existent board exits with a clear error.
- [ ] Workspace cleanup skips user-owned paths outside KDI-managed directories.
- [ ] Unit and CLI tests cover event deletion, log deletion, archived workspace
      cleanup, board resolution, and flag gating.

-------------------------------------------------------------------------------
Risks / Open Questions
-------------------------------------------------------------------------------
- **Risk:** Workspace cleanup could accidentally delete user data if the
  ownership heuristic is too broad.
  **Mitigation:** restrict deletion to paths under the board data directory or
  temp directories with a `kdi-` prefix; never delete the board workdir.
- **Risk:** Concurrent dispatcher runs may create new logs/events while GC runs.
  **Mitigation:** GC is an operator-run maintenance command; retention-based
  deletion uses a stable cutoff timestamp computed at command start.
- **Open question:** Should GC support `--dry-run`? Out of scope for KDI-021.
- **Open question:** Should GC clean orphaned task runs? Out of scope; task runs
  are retained for history until explicitly pruned in a future feature.

-------------------------------------------------------------------------------
Dependencies
-------------------------------------------------------------------------------
- `src/models/board.ts` (board resolution / validation).
- `src/models/taskEvent.ts` (event queries and deletion).
- `src/resolveBoard.ts` (board resolution chain).
- `src/observability.ts` (log path derivation).
- `src/flags.ts` (`FF_GC`).
