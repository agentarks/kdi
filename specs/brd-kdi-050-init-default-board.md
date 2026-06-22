# BRD-KDI-050: Ensure `default` Board Exists After `kdi init`

## Goal
Make `kdi init` idempotently create a `default` board so that board-less commands (e.g., `kdi boards show`, `kdi create`) that resolve to the `"default"` fallback work immediately after initialization, matching Hermes behavior.

## Background
The board resolution chain falls back to `"default"` when no `--board` flag, `KDI_BOARD` environment variable, or current-board file is set. Currently `kdi init` only creates the database schema, so a fresh install fails with `Board "default" not found.` until the user explicitly runs `kdi boards create default --workdir <path>`.

Hermes treats the `default` board as always present. KDI should guarantee the same by creating the board during initialization.

## Acceptance Criteria

1. `kdi init` creates an active board with slug `default` when one does not already exist.
2. `kdi init` on a database that already has a `default` board (active or archived) is idempotent: it does not error and does not create a duplicate.
3. The default board's `workdir` is the KDI board data directory for the `default` slug (`<kdi_data_dir>/boards/default`).
4. The default board's `name` defaults to the slug (`default`) and no other metadata is set.
5. `kdi init --path <db_path>` creates the default board relative to the specified database location.
6. `kdi init --force` refreshes the schema without deleting or unarchiving an existing `default` board.
7. After `kdi init`, `kdi boards show` resolves to and displays the `default` board.
8. After `kdi init`, `kdi create "title"` (with no explicit board) creates the task on the `default` board.

## Non-Goals / Out of Scope

- Auto-creating a `default` board on implicit database initialization during other commands.
- Changing the board resolution chain or the `"default"` fallback value.
- Populating the `default` board with sample tasks or metadata.
- Unarchiving a previously archived `default` board.

## Feature Flag

No new feature flag. `kdi init` and board creation are foundational commands exempt from feature-flag gating per `specs/feature-flags.md`. This change completes the foundational setup so that the existing resolution chain behaves as documented.

## Dependencies

- Existing `boards` table schema and `createBoard` model helper.
- Existing `resolveBoard` fallback to `"default"`.

## Testing

- Unit test: `kdi init` on a fresh path creates the `default` board row.
- Unit test: `kdi init` on an existing database with a `default` board is idempotent.
- Unit test: `kdi init --path <custom>` creates the default board in the custom database.
- E2e test: after `kdi init`, `kdi boards show` displays the `default` board and `kdi create "x"` stores a task on it.
