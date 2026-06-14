# BRD-KDI-023: Context Builder

-------------------------------------------------------------------------------
Business Goal
-------------------------------------------------------------------------------
Give a harness worker a single, bounded, self-contained view of everything it
needs to work on a task: the task itself, what has already been attempted,
what upstream tasks concluded, who has touched the task, and any human
commentary. The context builder prevents prompt overflow by capping every
free-text field and lets file-tool-wielding agents discover attachment absolute
paths.

-------------------------------------------------------------------------------
User Stories
-------------------------------------------------------------------------------
1. As a harness worker, I receive a deterministic prompt from
   `kdi context <task_id>` that contains the task title, body, parent results,
   prior attempts, role history, comments, and attachment paths.
2. As an operator, I can inspect the same context as JSON with
   `kdi context <task_id> --json` for debugging or external orchestration.
3. As a task author, I know that huge task bodies or long comment threads will
   not silently overflow a model context window because the builder caps every
   field.
4. As a harness author, I can read attached files because the context exposes
   their absolute filesystem paths.

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------
- `kdi context <task_id> [--board <slug>] [--json]` prints the worker context
  for the resolved board and task.
- The command is read-only: it never mutates tasks, runs, events, or comments.
- Context is composed from the following sections, in order:
  1. **Task header** — `task_id`, `title`, `assignee`, `status`, `priority`,
     `tenant`, `created_by`.
  2. **Body** — the task body (`tasks.body`).
  3. **Parent results** — concatenated results of done parent tasks linked via
     the `dependencies` table.
  4. **Prior attempts** — `task_runs` rows for this task, ordered newest first.
  5. **Role history** — chronological trace built from `task_events`.
  6. **Comments** — rows from the `comments` table, oldest first.
  7. **Attachments** — absolute paths to files attached to the task.
- Board resolution follows the standard chain:
  `--board` flag → `KDI_BOARD` env → current-board file → `"default"`.
- The command exits with a clear error if the task does not exist or is
  archived.
- When `--json` is omitted, output is plain text with Markdown-style headings.
- When `--json` is provided, output is a single stable JSON object.

-------------------------------------------------------------------------------
Field-Level Caps (Prompt Overflow Prevention)
-------------------------------------------------------------------------------
All caps are character counts measured after trimming whitespace. Values longer
than a cap are truncated at the cap and suffixed with `"\n[truncated]"`.

| Field | Cap | Rationale |
|---|---|---|
| Title | 500 | Headings must stay small. |
| Body | 8,000 | Largest single text block; still fits in most context windows. |
| Per parent result | 2,000 | Parent results are additive; cap each parent. |
| Per prior-attempt summary | 2,000 | Run summaries can be verbose. |
| Per prior-attempt error | 2,000 | Stack traces can be large. |
| Per comment | 2,000 | Comments should be concise; long ones are truncated. |
| Role-history note | 500 | Event notes are short metadata. |
| Attachments listed | 20 | Prevent huge file lists from dominating context. |
| Total parent results included | 10 | Limit additive parent context. |
| Total prior attempts included | 20 | Older runs are progressively less relevant. |
| Total role-history entries | 100 | Very chatty event streams are bounded. |
| Total comments included | 50 | Older comments are dropped after the cap. |

Selection rules when a count cap is exceeded:
- Parent results: include parents in insertion order (oldest dependency first),
  stop at the cap.
- Prior attempts: order by `started_at DESC`; include newest first, stop at
  the cap. Older attempts are summarized with a line such as
  "(N older attempts omitted)" in text output, or `older_attempts_omitted: N`
  in JSON.
- Role history: order by `created_at ASC`; include earliest first, stop at the
  cap. Omitted entries are reported similarly.
- Comments: order by `created_at ASC`; include earliest first, stop at the cap.

-------------------------------------------------------------------------------
CLI Surface
-------------------------------------------------------------------------------
- `kdi context <task_id>` — human-readable worker context.
- `kdi context <task_id> --json` — machine-readable worker context.
- `kdi context <task_id> --board <slug>` — override board resolution.

-------------------------------------------------------------------------------
Context Composition Details
-------------------------------------------------------------------------------

### Task header
- Resolved from the task row.
- `assignee` and `tenant` are omitted from output when null.
- `created_by` is included only when `ff_created_by` is enabled.

### Body
- Uses `tasks.body` (null → empty string after trimming).
- Trimmed and capped at 8,000 characters.

### Parent results
1. Query `dependencies` for rows where `child_id = <task_id>`.
2. Join to `tasks` and filter parents with `status = 'done'` and
   `archived_at IS NULL`.
3. For each parent, include:
   - `task_id`
   - `title` (capped)
   - `result` (capped)
   - `summary` (capped)
4. Order by `dependencies.parent_id ASC` (stable insertion order).
5. Apply the 10-parent count cap.
6. Text output format:
   ```
   ## Parent Results

   ### Parent #123: <title>
   Result: <result>
   Summary: <summary>
   ```
7. JSON output is an array under `parents`.

### Prior attempts
1. Query `task_runs` where `task_id = ?` ordered by `started_at DESC`.
2. For each run include:
   - `run_id`
   - `profile`
   - `status`
   - `outcome`
   - `summary` (capped)
   - `error` (capped)
   - `started_at`
   - `ended_at`
3. Apply the 20-run count cap.
4. Text output groups runs with headings and labels such as
   `Run 3 (opencode) — crashed`.
5. JSON output is an array under `prior_attempts`.

### Role history
1. Query `task_events` where `task_id = ?` ordered by `created_at ASC`.
2. Recognize the following event kinds as role-relevant:
   `created`, `assigned`, `unassigned`, `claimed`, `reclaimed`, `completed`,
   `blocked`, `unblocked`, `reviewed`, `specified`, `ready`, `scheduled`.
3. Derive an `actor` for each event:
   - `created`: `tasks.created_by`.
   - `assigned`: from event payload `assignee`.
   - `claimed`, `reclaimed`: from the run's `profile` when a `run_id` is present,
     otherwise from payload `profile`.
   - All other kinds: from payload `actor`, `by`, `profile`, or `assignee` in
     that order; fall back to `"unknown"`.
4. Include a `note` for kinds that carry one:
   - `blocked`: payload `reason`.
   - `reclaimed`: payload `reason`.
   - `reviewed`: payload `reason`.
   - `heartbeat`: payload `note`.
5. Apply the 100-entry count cap.
6. Text output is a bulleted list: `- <timestamp> <event> by <actor>: <note>`.
7. JSON output is an array under `role_history` with shape
   `{ at, event, actor, note }`.

### Comments
1. Query `comments` where `task_id = ?` ordered by `created_at ASC`.
2. For each comment include:
   - `id`
   - `author` — from `comments.author` when the column exists (KDI-033),
     otherwise `"user"`.
   - `text` (capped)
   - `created_at`
3. Apply the 50-comment count cap.
4. Text output format:
   ```
   [2026-06-13T12:34:56Z] alice: <text>
   ```
5. JSON output is an array under `comments`.

### Attachments
1. Query `task_attachments` where `task_id = ?` (KDI-022 schema).
2. For each attachment:
   - `filename`
   - `absolute_path` — resolve `stored_path`:
     - If already absolute, use it as-is.
     - If relative, resolve it against
       `<board_data_dir>/attachments/<task_id>/`.
3. Apply the 20-attachment count cap.
4. If the `task_attachments` table does not exist (KDI-022 not yet merged),
  the builder returns an empty attachments list and does not error.
5. Text output lists one path per line under `## Attachments`.
6. JSON output is an array under `attachments` with shape
   `{ filename, absolute_path }`.

-------------------------------------------------------------------------------
JSON Output Schema
-------------------------------------------------------------------------------
```json
{
  "task_id": 456,
  "title": "Fix auth bug",
  "assignee": "opencode",
  "status": "ready",
  "priority": 5,
  "tenant": "backend",
  "created_by": "orchestrator",
  "body": "...",
  "parents": [
    {
      "task_id": 123,
      "title": "Implement login",
      "result": "...",
      "summary": "..."
    }
  ],
  "older_parents_omitted": 0,
  "prior_attempts": [
    {
      "run_id": 3,
      "profile": "opencode",
      "status": "crashed",
      "outcome": "crashed",
      "summary": "...",
      "error": "...",
      "started_at": 1718270096,
      "ended_at": 1718270097
    }
  ],
  "older_attempts_omitted": 0,
  "role_history": [
    {
      "at": 1718270000,
      "event": "created",
      "actor": "orchestrator",
      "note": null
    }
  ],
  "older_role_history_omitted": 0,
  "comments": [
    {
      "id": 1,
      "author": "user",
      "text": "...",
      "created_at": 1718270010
    }
  ],
  "older_comments_omitted": 0,
  "attachments": [
    {
      "filename": "screenshot.png",
      "absolute_path": "/Users/.../.local/share/kdi/boards/myproj/attachments/456/screenshot.png"
    }
  ]
}
```

-------------------------------------------------------------------------------
Non-Functional Requirements
-------------------------------------------------------------------------------
- CLI response time remains sub-100ms for tasks with up to 50 runs, 100 events,
  and 50 comments.
- Context building is deterministic: repeated invocations for the same task
  produce identical output (ignoring wall-clock timestamps introduced by the
  command itself, of which there are none).
- No mutation of database rows.
- Output remains usable when optional dependencies (KDI-022 attachments,
  KDI-033 comment author) are absent.

-------------------------------------------------------------------------------
Feature Flag Requirements
-------------------------------------------------------------------------------
- `ff_context_builder` registered in `src/flags.ts`:
  ```ts
  export const FF_CONTEXT_BUILDER = "FF_CONTEXT_BUILDER";
  registerFlag(FF_CONTEXT_BUILDER, false);
  ```
- Env var form: `FF_CONTEXT_BUILDER=false`.
- Defaults to `false` in every environment.
- `kdi context` is rejected with "Context builder is not enabled." when the
  flag is disabled.

-------------------------------------------------------------------------------
Schema Changes
-------------------------------------------------------------------------------
No schema changes are required for KDI-023 itself. The context builder reads
from existing tables:
- `tasks`, `boards`, `dependencies`, `task_runs`, `task_events`, `comments`.

It optionally reads from future tables:
- `task_attachments` (KDI-022) — tolerated if missing.
- `comments.author` (KDI-033) — tolerated if missing; falls back to `"user"`.

-------------------------------------------------------------------------------
Model Behavior
-------------------------------------------------------------------------------
1. `buildTaskContext(taskId, boardSlug)` resolves the board and verifies the
   task exists and is not archived.
2. Each section is loaded by a dedicated helper:
   - `loadTaskHeader(task)`
   - `loadTaskBody(task)`
   - `loadParentResults(taskId)`
   - `loadPriorAttempts(taskId)`
   - `loadRoleHistory(taskId, task)`
   - `loadComments(taskId)`
   - `loadAttachments(taskId, boardSlug)`
3. Each helper applies its caps before returning data.
4. The command handler formats the result for text or JSON output.

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
- [ ] `FF_CONTEXT_BUILDER=true kdi context <task_id>` prints a human-readable
      context with all seven sections.
- [ ] `FF_CONTEXT_BUILDER=true kdi context <task_id> --json` returns valid JSON
      matching the documented schema.
- [ ] Context builder resolves the board via the standard resolution chain when
      `--board` is omitted.
- [ ] `FF_CONTEXT_BUILDER=false kdi context <task_id>` exits with
      "Context builder is not enabled."
- [ ] `kdi context <nonexistent_id>` exits with a clear "Task not found" error.
- [ ] A task with a body longer than 8,000 characters has its body truncated
      and suffixed with `[truncated]`.
- [ ] A task with more than 20 prior attempts shows the newest 20 and reports
      the number of omitted older attempts.
- [ ] Parent results include only done parents and concatenate their capped
      `result` and `summary`.
- [ ] Role history derives actors correctly for `created`, `assigned`,
      `claimed`, and `reclaimed` events.
- [ ] Comments appear in chronological order and respect the 50-comment cap.
- [ ] Attachment paths are absolute and resolved relative to
      `<board_data_dir>/attachments/<task_id>/` when stored paths are relative.
- [ ] When `task_attachments` does not exist, `attachments` is empty and the
      command succeeds.
- [ ] The command performs no database writes.
- [ ] Unit and CLI tests cover happy path, truncation, caps, missing task,
      flag gating, and JSON output.

-------------------------------------------------------------------------------
Risks / Open Questions
-------------------------------------------------------------------------------
- **Risk:** Caps are arbitrary and may be too small for some agents.
  **Mitigation:** document them clearly and make them constants so they can be
  tuned or exposed as CLI flags in a future BRD without breaking output shape.
- **Risk:** Parent-result concatenation can still bloat prompts if many parents
  are done.
  **Mitigation:** 10-parent count cap plus per-parent 2,000-character cap.
- **Risk:** Event payload shapes are not strictly normalized, so actor
  extraction is heuristic.
  **Mitigation:** define a priority order for payload keys and fall back to
  `"unknown"`; add tests for each recognized event kind.
- **Risk:** KDI-022 and KDI-033 are not implemented, so attachment and comment
  author features cannot be fully verified yet.
  **Mitigation:** design the context builder to be tolerant of missing columns
  and tables; add tests that mock or skip those sections until the dependency
  BRDs land.
- **Open question:** Should the context builder include the task log path from
  KDI-018? Defer to a future BRD; KDI-023 focuses on prompt content, not log
  references.
- **Open question:** Should there be a `--max-tokens` adaptive cap? Out of
  scope; this BRD uses fixed character caps for predictability.

-------------------------------------------------------------------------------
Dependencies
-------------------------------------------------------------------------------
- `src/flags.ts` (`FF_CONTEXT_BUILDER`).
- `src/resolveBoard.ts` (board resolution chain).
- `src/models/task.ts` (`showTask`, `TASK_COLUMNS`).
- `src/models/dependency.ts` (`getParentTasks` or equivalent).
- `src/models/taskRun.ts` (`getRuns`).
- `src/models/taskEvent.ts` (`getEvents`).
- `src/models/comment.ts` (`getComments`).
- `src/commands/tasks.ts` or a new `src/commands/context.ts` (`kdi context`).
- Future: `src/models/attachment.ts` (KDI-022) for attachment path resolution.
- Future: `comments.author` column (KDI-033) for comment authorship.
