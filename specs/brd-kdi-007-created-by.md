BRD-KDI-007: Created-by Tracking
================================

-------------------------------------------------------------------------------
Business Goal
-------------------------------------------------------------------------------
Track the identity of the actor that created each task so operators can audit
provenance, filter task lists by creator, and attribute work to the correct
human, harness profile, or external system.

-------------------------------------------------------------------------------
User Stories
-------------------------------------------------------------------------------
1. As an operator, I can see who created a task when I run `kdi show <id>`.
2. As an operator, I can override the creator at creation time so scripts and
   dispatchers can record the real actor (e.g. the harness profile).
3. As a board administrator, I can list tasks created by a specific actor.
4. As a reviewer, I can trust that the creator field is immutable after task
   creation.

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------
- `created_by` column on `tasks` stores a non-empty text identifier.
- `kdi create` accepts an optional `--created-by <actor>` argument.
- If `--created-by` is omitted, `kdi create` resolves the actor in order:
  1. `KDI_CREATED_BY` environment variable.
  2. `process.env.USER` (fallback to "unknown").
- `kdi show <id>` displays `Created by: <actor>`.
- `kdi list --board <slug> --created-by <actor>` filters tasks by creator.
- The feature is gated behind `ff_created_by` and defaults to `false`.
- When the flag is disabled, the CLI must reject `--created-by` and
  `--created-by` filters with a clear error, and `kdi show` must not display
  the field.
- Existing tasks created before this feature must report `created_by` as
  `"unknown"` (schema migration default).

-------------------------------------------------------------------------------
Non-Functional Requirements
-------------------------------------------------------------------------------
- Creator identifier max length: 255 characters (matches TEXT column length
  convention).
- CLI response time remains sub-100ms.
- No breaking change to existing `create`, `show`, or `list` output when the
  feature flag is disabled.

-------------------------------------------------------------------------------
Feature Flag Requirements
-------------------------------------------------------------------------------
- `ff_created_by` registered in `specs/feature-flags.md`.
- Env var form: `FF_CREATED_BY=false`.
- Defaults to `false` in all environments.

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
- [ ] `FF_CREATED_BY=true kdi create "x" --board b --created-by alice` returns
      a task ID and `kdi show <id>` prints `Created by: alice`.
- [ ] `FF_CREATED_BY=true kdi create "x" --board b` with `KDI_CREATED_BY=bob`
      creates a task whose creator is `bob`.
- [ ] `FF_CREATED_BY=true kdi create "x" --board b` with no env var and no
      flag creates a task whose creator equals `process.env.USER`.
- [ ] `FF_CREATED_BY=true kdi list --board b --created-by alice` lists only
      tasks created by `alice`.
- [ ] `FF_CREATED_BY=false kdi create "x" --board b --created-by alice` fails
      with "Created-by tracking is not enabled."
- [ ] `FF_CREATED_BY=false kdi list --board b --created-by alice` fails with
      "Created-by tracking is not enabled."
- [ ] `FF_CREATED_BY=false kdi show <id>` does not print a `Created by:` line.
- [ ] `kdi list` output remains unchanged when the flag is disabled.
- [ ] Migration populates `created_by = 'unknown'` for existing task rows.
- [ ] Unit tests cover create, show, list, flag-gating, and env fallback.

-------------------------------------------------------------------------------
Risks and Mitigations
-------------------------------------------------------------------------------
- Risk: Existing tests assert exact `show` output and break when `Created by:`
  appears.
  Mitigation: hide the line behind the feature flag and add explicit evals.
- Risk: Filtering by `created_by` without an index is slow on large boards.
  Mitigation: add `idx_tasks_created_by` composite index on
  `(board_id, created_by)`.

-------------------------------------------------------------------------------
Dependencies
-------------------------------------------------------------------------------
- Task model and CLI (`kdi create`, `kdi show`, `kdi list`).
- Feature flag registry (`src/flags.ts`).
