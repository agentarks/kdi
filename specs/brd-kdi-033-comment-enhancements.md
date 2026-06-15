# BRD-KDI-033: `kdi comment` Enhancements

-------------------------------------------------------------------------------
Business Goal
-------------------------------------------------------------------------------
Make task comments more useful for multi-agent and multi-user boards by
recording who authored a comment and by allowing callers to cap the stored
comment length. This improves auditability and prevents accidental storage
bloat when comments are generated from large external outputs.

-------------------------------------------------------------------------------
User Stories
-------------------------------------------------------------------------------
1. As an operator, I can attribute a comment to a specific author with
   `kdi comment <task_id> <text> --author <name>`.
2. As an agent, I want my comments to default to my current profile so I do
   not have to pass `--author` every time.
3. As an operator, I can trim a long comment to a maximum length with
   `kdi comment <task_id> <text> --max-len <n>`.
4. As a reviewer, I want `kdi show <task_id>` to display the comment author
   alongside each comment.

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------
- `kdi comment <task_id> <text>` continues to add a comment to the task.
- `--author <name>` stores `<name>` as the comment author. The default author
  is resolved from `KDI_PROFILE`, then `HERMES_PROFILE`, then `"user"`.
- `--max-len <n>` trims the stored comment text to the first `<n>`
  characters. `<n>` must be a positive integer. The trimmed text is stored;
  no truncation marker is appended.
- `kdi show <task_id>` displays each comment with its author and timestamp
  when the feature flag is enabled.
- If `--max-len` is omitted, the full comment text is stored (subject to any
  existing database limits).
- Empty author strings are rejected with a clear error.
- Non-numeric, zero, or negative `--max-len` values are rejected with a clear
  error.
- Existing comments without an `author` value display `"user"` as the fallback
  author in `kdi show`.

-------------------------------------------------------------------------------
Non-Functional Requirements
-------------------------------------------------------------------------------
- CLI response time remains sub-100ms for comment creation and retrieval.
- No breaking change to the existing `kdi comment <task_id> <text>` command
  when the flag is disabled.
- No breaking change to `kdi show` output when the flag is disabled.

-------------------------------------------------------------------------------
Feature Flag Requirements
-------------------------------------------------------------------------------
- `ff_comment_enhancements` registered in `src/flags.ts`:
  ```ts
  export const FF_COMMENT_ENHANCEMENTS = "FF_COMMENT_ENHANCEMENTS";
  registerFlag(FF_COMMENT_ENHANCEMENTS, false);
  ```
- Env var form: `FF_COMMENT_ENHANCEMENTS=false`.
- Defaults to `false` in every environment.
- When disabled, `kdi comment --author` and `kdi comment --max-len` are
  rejected with "Comment enhancements feature is not enabled."
- When disabled, `kdi show` does not display comment authors.

-------------------------------------------------------------------------------
Schema Changes
-------------------------------------------------------------------------------
Add an `author TEXT` column to the `comments` table with a migration guarded
by `PRAGMA table_info(comments)`:

```ts
const commentsTableInfo = dbInstance.query("PRAGMA table_info(comments)").all() as any[];
if (!commentsTableInfo.some((col) => col.name === "author")) {
  dbInstance.exec("ALTER TABLE comments ADD COLUMN author TEXT");
}
```

Existing comments have `author = NULL`; `kdi show` falls back to `"user"` for
those rows.

Update the baseline `comments` table schema to include `author TEXT` so that
fresh databases include the column.

-------------------------------------------------------------------------------
CLI Surface
-------------------------------------------------------------------------------
- `kdi comment <task_id> <text> [--author <name>] [--max-len <n>]`
  — add a comment with optional author and length cap.
- `kdi show <task_id>` — display comments with author when flag enabled.

-------------------------------------------------------------------------------
Model Behavior
-------------------------------------------------------------------------------
1. Extend `AddCommentInput`:
   ```ts
   export interface AddCommentInput {
     task_id: number;
     text: string;
     author?: string;
     max_len?: number;
   }
   ```
2. `addComment(input)`:
   - Resolve `author` from `input.author ?? resolveCurrentAuthor()`.
   - Reject empty `author`.
   - If `input.max_len` is provided, validate it is a positive integer and
     trim `input.text` to `input.max_len` characters before storage.
   - Insert the comment with `author` and the (possibly trimmed) `text`.
3. `resolveCurrentAuthor()` helper:
   - Returns `Bun.env.KDI_PROFILE ?? Bun.env.HERMES_PROFILE ?? "user"`.
   - Lives in the command layer or a shared CLI helper, not in the model.
4. `getComments(taskId)`:
   - Returns comments ordered by `created_at DESC` (existing behavior).
   - Each row includes `author` (nullable).
5. `kdi show` display:
   - When the flag is enabled, format each comment as:
     ```
     <timestamp>  <author>:
     <text>
     ```
   - When `author` is `NULL`, display `"user"`.

-------------------------------------------------------------------------------
Command Handler Behavior
-------------------------------------------------------------------------------
1. Parse `--author <name>` and `--max-len <n>` with Commander.
2. Reject both options with the feature-disabled error when
   `FF_COMMENT_ENHANCEMENTS` is false.
3. Resolve default author in the command handler and pass it to
   `addComment()`.
4. Validate `--max-len` in the command handler or model; reject non-numeric,
   zero, and negative values.
5. Reject empty `--author ""`.

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
- [ ] `FF_COMMENT_ENHANCEMENTS=true kdi comment 1 "hello" --author alice`
      stores a comment with author `alice`.
- [ ] `FF_COMMENT_ENHANCEMENTS=true KDI_PROFILE=alice kdi comment 1 "hello"`
      stores a comment with author `alice`.
- [ ] `FF_COMMENT_ENHANCEMENTS=true kdi comment 1 "hello"` with no profile
      env var stores author `user`.
- [ ] `FF_COMMENT_ENHANCEMENTS=true kdi comment 1 "hello world" --max-len 5`
      stores comment text `hello`.
- [ ] `FF_COMMENT_ENHANCEMENTS=true kdi show 1` displays each comment with
      its author and timestamp.
- [ ] Pre-existing comments with `author = NULL` display author `user` when
      the flag is enabled.
- [ ] `FF_COMMENT_ENHANCEMENTS=false kdi comment 1 "x" --author alice` exits
      with "Comment enhancements feature is not enabled."
- [ ] `FF_COMMENT_ENHANCEMENTS=false kdi comment 1 "x" --max-len 5` exits
      with the same feature-disabled error.
- [ ] Empty `--author ""` is rejected with a clear error.
- [ ] `--max-len 0`, `--max-len -1`, and `--max-len abc` are rejected with
      clear errors.
- [ ] Unit and CLI tests cover author resolution, max-len trimming, flag
      gating, and `kdi show` display.

-------------------------------------------------------------------------------
Risks / Open Questions
-------------------------------------------------------------------------------
- **Risk:** Long comments trimmed by `--max-len` lose information.
  **Mitigation:** `--max-len` is opt-in; callers decide the cap.
- **Risk:** Default author resolution depends on environment variables that
  may differ between the shell that created the comment and later reviewers.
  **Mitigation:** document that the default author is the caller's current
  profile at comment time.
- **Open question:** Should comments also store the original (untrimmed) text
  in a separate column for audit? Out of scope for KDI-033.
- **Open question:** Should `kdi comment` support a `--max-len` default via env
  (e.g. `KDI_COMMENT_MAX_LEN`)? Out of scope for KDI-033.

-------------------------------------------------------------------------------
Dependencies
-------------------------------------------------------------------------------
- `src/db.ts` (schema + migration for `comments.author` column).
- `src/models/comment.ts` (`addComment`, `getComments`, `AddCommentInput`).
- `src/commands/tasks.ts` (`commentCommand`, `showTaskCommand`).
- `src/flags.ts` (`FF_COMMENT_ENHANCEMENTS`).
