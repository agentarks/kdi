# BRD-KDI-024: Assignees Listing

-------------------------------------------------------------------------------
Business Goal
-------------------------------------------------------------------------------
Give operators a single command to see who can be assigned work and how many
tasks each known profile already owns on the current board. This makes it easy
to balance load across agents and to discover profiles that are configured but
not yet used.

-------------------------------------------------------------------------------
User Stories
-------------------------------------------------------------------------------
1. As an operator, I can list every known profile with `kdi assignees`.
2. As an operator, I can see how many non-archived tasks each profile owns on
   the current board.
3. As an operator, I can discover assignees that exist only on the board (not
   in the profile registry).
4. As a tooling author, I can consume the same list as JSON with
   `kdi assignees --json`.

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------
- `kdi assignees [--board <slug>]` prints a human-readable list for the
  resolved board.
- The list contains the union of:
  - Known profiles loaded from the KDI profile registry
    (`~/.config/kdi/profiles.yaml` plus built-in profiles).
  - Distinct non-null `assignee` values present on non-archived tasks in the
    resolved board.
- Each row shows a profile name and the count of non-archived tasks assigned to
  that profile on the board.
- Profiles with no assigned tasks show a count of `0`.
- Rows are sorted alphabetically by profile name.
- `kdi assignees --json` outputs a JSON object:
  ```json
  {
    "board": "myproj",
    "assignees": [
      { "profile": "alpha", "count": 2 },
      { "profile": "beta", "count": 0 },
      { "profile": "gamma", "count": 1 }
    ]
  }
  ```
- The board is resolved via the standard chain:
  `--board` flag → `KDI_BOARD` env → current-board file → `"default"`.

-------------------------------------------------------------------------------
Non-Functional Requirements
-------------------------------------------------------------------------------
- CLI response time remains sub-100ms for boards with up to 10,000 tasks.
- `kdi assignees --json` output is stable and parseable by external tools.
- No breaking change to other CLI commands.

-------------------------------------------------------------------------------
Feature Flag Requirements
-------------------------------------------------------------------------------
- `ff_assignees_listing` registered in `src/flags.ts`:
  ```ts
  export const FF_ASSIGNEES_LISTING = "FF_ASSIGNEES_LISTING";
  registerFlag(FF_ASSIGNEES_LISTING, false);
  ```
- Env var form: `FF_ASSIGNEES_LISTING=false`.
- Defaults to `false` in every environment.
- `kdi assignees` is rejected when the flag is disabled.

-------------------------------------------------------------------------------
Schema Changes
-------------------------------------------------------------------------------
No schema changes are required. The feature reads from the existing `tasks`
table and uses the existing `idx_tasks_assignee` index.

-------------------------------------------------------------------------------
CLI Surface
-------------------------------------------------------------------------------
- `kdi assignees [--board <slug>]` — human-readable assignee list.
- `kdi assignees --json [--board <slug>]` — JSON output.

-------------------------------------------------------------------------------
Model Behavior
-------------------------------------------------------------------------------
1. `getAssigneeCounts(boardId)` returns a `Record<string, number>` of
   non-archived task counts grouped by `assignee` for the given board.
2. Query:
   ```sql
   SELECT assignee, COUNT(*) AS count
   FROM tasks
   WHERE board_id = ? AND assignee IS NOT NULL AND archived_at IS NULL
   GROUP BY assignee
   ```
3. The command handler unions the profile registry names with the keys from
   `getAssigneeCounts`, sorts the result, and fills missing counts with `0`.

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
- [x] `FF_ASSIGNEES_LISTING=true kdi assignees --board myproj` lists every
      known profile and board-only assignee with per-profile task counts.
- [x] `FF_ASSIGNEES_LISTING=true kdi assignees` resolves the board via the
      standard chain.
- [x] `FF_ASSIGNEES_LISTING=true kdi assignees --json` returns valid JSON
      matching the documented shape.
- [x] Counts include all non-archived tasks assigned to a profile.
- [x] Archived tasks are excluded from counts.
- [x] Unassigned tasks do not appear as an assignee row.
- [x] `FF_ASSIGNEES_LISTING=false kdi assignees` exits with "Assignees listing
      feature is not enabled."
- [x] `kdi assignees` for an archived or non-existent board exits with a clear
      error.
- [x] Unit and CLI tests cover counts, JSON output, board resolution, archived
      exclusion, and flag gating.

-------------------------------------------------------------------------------
Risks / Open Questions
-------------------------------------------------------------------------------
- **Risk:** The backlog references `~/.config/kdi/profiles/` as the profile
  source. KDI currently stores profiles in `~/.config/kdi/profiles.yaml`. The
  implementation uses the existing YAML registry (`loadProfiles`) to avoid
  introducing a second profile storage convention. If a profile directory is
  adopted later, this command should be updated to union both sources.
- **Risk:** Large boards could make the grouped query slow without proper
  indexing.
  **Mitigation:** rely on the existing `idx_tasks_assignee` index; add a
  composite board/assignee index if profiling shows a hotspot.
- **Open question:** Should the command support filtering by status (e.g., only
  active tasks)? Out of scope for KDI-024; counts reflect all non-archived
  assigned tasks.

-------------------------------------------------------------------------------
Dependencies
-------------------------------------------------------------------------------
- `src/models/board.ts` (board resolution / validation).
- `src/models/task.ts` (`getAssigneeCounts`).
- `src/commands/assignees.ts` (`kdi assignees`).
- `src/resolveBoard.ts` (board resolution chain).
- `src/flags.ts` (`FF_ASSIGNEES_LISTING`).
- `src/profiles.ts` (`loadProfiles`).
