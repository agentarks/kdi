# BRD-KDI-045: `kdi create --parent`

## Goal
Add a repeatable `--parent` option to `kdi create` so users can declare parent->child task dependencies at task creation time, matching Hermes `create --parent` behavior.

## Acceptance Criteria

1. `kdi create "title" --parent <task_id>` creates the task and links the given task as a parent.
2. `--parent` can be repeated to add multiple parents.
3. Invalid parent IDs, missing parents, self-dependencies, and circular dependencies are rejected with clear errors.
4. Duplicate parent links are idempotent (no error on re-creation).
5. The feature is gated by `FF_CREATE_PARENT` and defaults to `false`.

## Out of Scope

- Changing `kdi create` default initial status (remains `todo`).
- Enforcing that parents and children live on the same board (consistent with `kdi link`).

## Dependencies

- Existing `dependencies` table and `addDependency` model helper.
- `FF_LINK_UNLINK` is independent; `--parent` uses its own flag.
