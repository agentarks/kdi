# BRD-KDI-050: Ensure `default` Board Exists After `kdi init`

-------------------------------------------------------------------------------
Problem Statement
-------------------------------------------------------------------------------
The board resolution chain falls back to `"default"` when no `--board` flag,
`KDI_BOARD` environment variable, or current-board file is set. Currently
`kdi init` only creates the database schema, so a fresh install fails with
`Board "default" not found.` until the user explicitly runs
`kdi boards create default --workdir <path>`.

Hermes treats the `default` board as always present. KDI should guarantee the
same by creating the board during initialization.

-------------------------------------------------------------------------------
Hermes Behavior
-------------------------------------------------------------------------------
Hermes Kanban initializes with a `default` board that always exists:

```
hermes init
hermes boards show
# default board is present
```

- The `default` board is created automatically during initialization.
- It is available immediately for board-less commands.
- No explicit `boards create default` is required.

-------------------------------------------------------------------------------
Current KDI Behavior
-------------------------------------------------------------------------------
Current KDI:

```
kdi init
kdi boards show
# Error: Board "default" not found.
```

- `kdi init` creates only the database schema and migrations.
- Board-less commands (e.g., `kdi boards show`, `kdi create`) fail because no
  `default` board exists.
- The user must manually create the `default` board before any board-less
  command works.

-------------------------------------------------------------------------------
Desired KDI Behavior
-------------------------------------------------------------------------------
```
kdi init
kdi boards show
# Board: default
# Workdir: <kdi_data_dir>/boards/default
# ...

kdi create "task title"
# task is created on the default board
```

- `kdi init` creates an active `default` board when one does not exist.
- `kdi init` is idempotent when the `default` board already exists.
- An archived `default` board is left archived; `kdi init` does not unarchive
  it.
- The default board's `workdir` is `<kdi_data_dir>/boards/default`.
- The default board's `name` defaults to the slug (`default`) and no other
  metadata is set.

-------------------------------------------------------------------------------
User Stories
-------------------------------------------------------------------------------
1. As a new user, I can run `kdi init` and immediately use `kdi boards show`
   without first creating a board manually.
2. As a script author, I can rely on `kdi create "title"` working after
   `kdi init` because the `default` board is guaranteed to exist.
3. As an operator, I can run `kdi init` repeatedly without errors even if the
   `default` board already exists.

-------------------------------------------------------------------------------
Current Behavior vs Desired Behavior
-------------------------------------------------------------------------------
| Aspect | Current | Desired |
|---|---|---|
| After `kdi init` | No `default` board exists | Active `default` board exists |
| `kdi boards show` (no current board) | Errors with `Board "default" not found.` | Displays the `default` board |
| `kdi create "title"` (no `--board`) | Errors with `Board "default" not found.` | Creates task on `default` board |
| `kdi init` repeat | Idempotent for schema only | Idempotent for schema and default board |
| `kdi init --force` | Deletes main database file and recreates schema | Preserves main database file, re-runs schema/migrations only |

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------
- `kdi init` creates an active board with slug `default` when one does not
  already exist.
- `kdi init` on a database that already has a `default` board (active or
  archived) is idempotent: it does not error and does not create a duplicate.
- The default board's `workdir` is the KDI board data directory for the
  `default` slug (`<kdi_data_dir>/boards/default`).
- The default board's `name` defaults to the slug (`default`) and no other
  metadata is set.
- `kdi init --path <db_path>` creates the default board relative to the
  specified database location.
- `kdi init --force` refreshes the schema and migrations without deleting the
  main database file or unarchiving an existing `default` board. Only
  transient WAL/SHM artifacts are removed to allow a fresh connection.
- After `kdi init`, `kdi boards show` resolves to and displays the `default`
  board.
- After `kdi init`, `kdi create "title"` (with no explicit board) creates the
  task on the `default` board.

-------------------------------------------------------------------------------
Non-Functional Requirements
-------------------------------------------------------------------------------
- `kdi init` remains sub-100ms on a fresh database.
- No breaking change to existing `kdi init --force` schema refresh semantics.
- Idempotency must hold across repeated invocations and concurrent processes.

-------------------------------------------------------------------------------
Feature Flag Requirements
-------------------------------------------------------------------------------
No new feature flag is required. `kdi init` and board creation are
foundational commands exempt from feature-flag gating per
`specs/feature-flags.md`. This change completes the foundational setup so that
the existing resolution chain behaves as documented.

-------------------------------------------------------------------------------
Schema / Migration Notes
-------------------------------------------------------------------------------
No schema changes are required. The feature uses the existing `boards` table
and the existing `createBoard` model helper.

-------------------------------------------------------------------------------
CLI Surface
-------------------------------------------------------------------------------
- `kdi init` — initialize the database and create the `default` board if
  missing.
- `kdi init --force` — re-run schema and migrations without deleting the main
  database file.
- `kdi init --path <db_path>` — initialize at a custom path and create the
  `default` board relative to that path.

-------------------------------------------------------------------------------
Model Behavior
-------------------------------------------------------------------------------
1. After `initDb(dbPath)` succeeds, query the `boards` table for a board with
   slug `default` (including archived boards).
2. If no `default` board exists:
   - Create the directory `<dirname(dbPath)>/boards/default`.
   - Call `createBoard("default", defaultWorkdir)` with no metadata.
3. If a `default` board already exists (active or archived), do nothing.

-------------------------------------------------------------------------------
Command Handler Behavior
-------------------------------------------------------------------------------
1. Parse `--force` and `--path` options as today.
2. Call `initDb(dbPath)` to set up the schema and migrations.
3. After successful initialization, ensure the `default` board exists using
   the model behavior above.
4. Print the existing success message: `Database initialized at <dbPath>`.

-------------------------------------------------------------------------------
Edge Cases
-------------------------------------------------------------------------------
| Scenario | Expected behavior |
|---|---|
| Fresh `kdi init` | Creates schema and active `default` board. |
| `kdi init` when `default` exists | Idempotent; no duplicate board. |
| `kdi init` when `default` is archived | Leaves archived; does not unarchive. |
| `kdi init --path custom.db` | Creates `default` board near `custom.db`. |
| `kdi init --force` | Re-runs schema/migrations; preserves `default` board. |
| Concurrent `kdi init` runs | Cross-process init lock serializes schema setup; duplicate board creation is guarded by the `boards.slug` UNIQUE constraint. |

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
- [x] BRD at `specs/brd-kdi-050-init-default-board.md` includes problem
      statement, current vs desired behavior, Hermes behavior, CLI changes,
      schema/migration notes, feature flag registration notes, and acceptance
      criteria focused on spec completeness.
- [x] `kdi init` creates an active `default` board when one does not exist.
- [x] `kdi init` is idempotent when the `default` board already exists.
- [x] The default board `workdir` is `<kdi_data_dir>/boards/default`.
- [x] `kdi init --path <db_path>` creates the default board relative to the
      custom database location.
- [x] `kdi init --force` preserves the main database file and does not
      unarchive an existing `default` board.
- [x] `kdi boards show` and `kdi create` work immediately after `kdi init`
      without an explicit board.
- [x] Test plan covers unit model tests and CLI integration tests.

-------------------------------------------------------------------------------
Risks / Open Questions
-------------------------------------------------------------------------------
- **Risk:** Existing users who rely on `kdi init --force` deleting the entire
  database file will see a behavior change. **Mitigation:** Update help text
  and documentation to clarify that `--force` re-runs schema/migrations and
  preserves data.
- **Open question:** If the `default` board exists but is archived, should
  `kdi init` unarchive it? This BRD specifies "no" for idempotency and to
  avoid surprising data resurrection; confirm with product owner.
- **Open question:** Should `kdi init` create the `default` board's workdir as
  a git repository? This BRD specifies "no"; the directory is created empty
  and tasks use it as a normal directory workspace unless the user later
  initializes git.

-------------------------------------------------------------------------------
Migration Notes
-------------------------------------------------------------------------------
- No database migration is required.
- No new feature flag is registered in `specs/feature-flags.md` because this
  change extends the foundational `kdi init` command, which is exempt from
  feature-flag gating.

-------------------------------------------------------------------------------
Dependencies
-------------------------------------------------------------------------------
- `src/db.ts` (`initDb`, `defaultDbPath`).
- `src/models/board.ts` (`createBoard`, `showBoard`).
- `src/commands/init.ts` (`initCommand`).

-------------------------------------------------------------------------------
Worktree Branch Name
-------------------------------------------------------------------------------
`feat/kdi-050-init-default-board`

-------------------------------------------------------------------------------
STATUS.md Update Notes
-------------------------------------------------------------------------------
Add a new section under the feature list:

```markdown
## Ensure `default` Board Exists After `kdi init` (KDI-050) — In Progress
- [ ] BRD drafted at `specs/brd-kdi-050-init-default-board.md`
- [ ] `kdi init` creates an active `default` board when one does not exist
- [ ] `kdi init` is idempotent when the `default` board already exists
- [ ] Default board workdir set to `<kdi_data_dir>/boards/default`
- [ ] `kdi boards show` and `kdi create` work immediately after `kdi init`
- [ ] Unit/e2e tests and user-loop smoke pass
- [ ] `bun run lint`, `bun run test`, `bun run build` pass
```
