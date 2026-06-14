# BRD-KDI-022: Task Attachments

-------------------------------------------------------------------------------
Business Goal
-------------------------------------------------------------------------------
Allow operators to attach files to a task so that supporting artifacts
(screenshots, logs, manifests, design documents) travel with the task through
its lifecycle and are available to harnesses and reviewers.

-------------------------------------------------------------------------------
User Stories
-------------------------------------------------------------------------------
1. As an operator, I can attach a file to a task with `kdi attach <task_id> <file>`.
2. As a reviewer, I can see a task's attachments when running `kdi show <id>`.
3. As a harness author, I can rely on attachment paths being stable and scoped
   to the task and board.
4. As a board owner, I expect hard-deleting a board to remove its attachment
   records and on-disk files.

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------
- `kdi attach <task_id> <file>` copies the source file into the board's data
  directory under `attachments/<task_id>/<filename>`.
- Each attachment creates a row in `task_attachments` with:
  - `task_id` (FK to tasks)
  - `filename` (basename of the source file)
  - `stored_path` (absolute path of the copied file)
  - `content_type` (MIME type when detectable, otherwise null)
  - `size` (bytes)
  - `uploaded_by` (defaults to `$KDI_PROFILE`, then `$USER`, then `"unknown"`)
  - `created_at`
- The command emits an `attached` event on the task with the filename and size.
- `kdi show <id>` prints a task's attachments (filename, size, absolute path)
  when the feature flag is enabled.
- Attachments are gated by `ff_task_attachments`. When disabled, `kdi attach` is
  rejected and `kdi show` hides attachment output.
- Hard-deleting a board (`kdi boards rm <slug> --delete`) cascade-deletes
  `task_attachments` rows and removes the board data directory (which includes
  the `attachments/` tree).
- Duplicate filename collisions for the same task are rejected with a clear
  error. Overwrite semantics are deferred to a future enhancement.
- Source paths that do not exist, are directories, or contain traversal
  components after basename resolution are rejected.

-------------------------------------------------------------------------------
Non-Functional Requirements
-------------------------------------------------------------------------------
- CLI response time remains sub-100ms for attachments under 10 MiB.
- Attachment storage lives alongside the board database so backup and cleanup
  are scoped per board.
- No breaking change to existing task lifecycle commands when the flag is
  disabled.

-------------------------------------------------------------------------------
Feature Flag Requirements
-------------------------------------------------------------------------------
- `ff_task_attachments` registered in `src/flags.ts`:
  ```ts
  export const FF_TASK_ATTACHMENTS = "FF_TASK_ATTACHMENTS";
  registerFlag(FF_TASK_ATTACHMENTS, false);
  ```
- Env var form: `FF_TASK_ATTACHMENTS=false`.
- Defaults to `false` in every environment.
- `kdi attach` is rejected and `kdi show` hides attachments when disabled.

-------------------------------------------------------------------------------
Schema Changes
-------------------------------------------------------------------------------
```sql
CREATE TABLE IF NOT EXISTS task_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  filename TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  content_type TEXT,
  size INTEGER NOT NULL,
  uploaded_by TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_task_attachments_task ON task_attachments(task_id);
```
A migration adds the table and index to existing databases.

-------------------------------------------------------------------------------
CLI Surface
-------------------------------------------------------------------------------
- `kdi attach <task_id> <file>` — attach a file to a task.
- `kdi show <id>` — displays attachments when the flag is enabled.

-------------------------------------------------------------------------------
Storage Layout
-------------------------------------------------------------------------------
- Board data directory: `<kdi_data>/boards/<board_slug>/`
- Attachment directory: `<board_data_dir>/attachments/<task_id>/`
- Stored file: `<attachment_dir>/<filename>`

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
- [ ] `FF_TASK_ATTACHMENTS=true kdi attach <task_id> <file>` copies the file,
      records metadata, and prints the attachment ID.
- [ ] `FF_TASK_ATTACHMENTS=true kdi show <id>` lists attachment filename, size,
      and stored path.
- [ ] `FF_TASK_ATTACHMENTS=false kdi attach <task_id> <file>` exits with
      "Task attachments feature is not enabled."
- [ ] `FF_TASK_ATTACHMENTS=false kdi show <id>` does not display an attachments
      section.
- [ ] `kdi attach` rejects a missing source file with a clear error.
- [ ] `kdi attach` rejects a source path that resolves to a directory.
- [ ] `kdi attach` rejects duplicate filenames for the same task.
- [ ] An `attached` event is recorded for the task.
- [ ] `kdi boards rm <slug> --delete` removes attachment rows and the on-disk
      `attachments/` directory.
- [ ] Unit and CLI tests cover the model, command gating, storage, and
      hard-delete cascade.

-------------------------------------------------------------------------------
Risks / Open Questions
-------------------------------------------------------------------------------
- **Risk:** Attachments may consume significant disk over time.
  **Mitigation:** future GC/retention BRD; for KDI-022, hard-delete removes
  board attachments.
- **Risk:** Attached files may contain secrets.
  **Mitigation:** store attachments in the user's home directory with standard
  permissions; do not log file contents.
- **Open question:** Should `kdi attach` support overriding the stored filename
  or replacing an existing attachment? This BRD defers both to future work.

-------------------------------------------------------------------------------
Dependencies
-------------------------------------------------------------------------------
- `src/db.ts` (schema, `getBoardDataDir`).
- `src/attachments.ts` (attachment path helper).
- `src/models/taskAttachment.ts` (attachment persistence and events).
- `src/commands/tasks.ts` (`kdi attach` command, `kdi show` attachment display).
- `src/models/board.ts` (hard-delete cascade).
- `src/flags.ts` (`FF_TASK_ATTACHMENTS`).
