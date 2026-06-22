# BRD-KDI-046: Align `boards rename` with Hermes semantics

-------------------------------------------------------------------------------
Business Goal
-------------------------------------------------------------------------------
Bring KDI's `boards rename` command into parity with Hermes Kanban semantics.
Hermes treats the board slug as an immutable identifier and `boards rename` as
a display-name edit only. KDI currently uses `boards rename` to mutate the
slug and data-directory name, which surprises Hermes migrants and overloads
the natural meaning of "rename". This BRD corrects that while preserving the
existing slug-rename capability under a more explicit command name.

-------------------------------------------------------------------------------
User Stories
-------------------------------------------------------------------------------
1. As a Hermes user adopting KDI, I can run
   `kdi boards rename myproj "My Project"` and change only the display name,
   leaving the slug and directory intact.
2. As an operator who needs to fix a typo in a board slug, I can still move a
   board's identity via `kdi boards rename-slug oldslug newslug`.
3. As a script author, I can rely on board slugs remaining stable after a
   display-name change so that `--board`, paths, and current-board files keep
   working.

-------------------------------------------------------------------------------
Current Behavior vs Desired Behavior
-------------------------------------------------------------------------------
Current KDI (gated by `FF_BOARD_RENAME`):

```
kdi boards rename <old-slug> <new-slug>
```

- Updates the `boards.slug` column.
- Renames the board data directory on disk (`getBoardDataDir`).
- Updates the `~/.local/share/kdi/current` file if it pointed to the old slug.
- Leaves the display name (`boards.name`) unchanged.

This matches a filesystem "move/rename" operation, not the Hermes Kanban
`boards rename <slug> <name>` command.

Desired KDI behavior:

```
kdi boards rename <slug> <name>       # Hermes parity: change display name only
kdi boards rename-slug <old-slug> <new-slug>  # existing slug move capability
```

- `kdi boards rename <slug> <name>` updates `boards.name` only. The slug,
  data directory, and current-board file are untouched.
- `kdi boards rename-slug <old-slug> <new-slug>` preserves today's slug-rename
  behavior (slug column, directory rename, current-board update).
- Both commands reject invalid/empty inputs, missing boards, and archived
  boards with clear errors.

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------
- `kdi boards rename <slug> <name>`:
  - Requires exactly two positional arguments: the existing board slug and the
    new display name.
  - Trims whitespace from `<name>`; rejects empty or all-whitespace names.
  - Updates `boards.name` for the matching non-archived board.
  - Does not modify `boards.slug`, the board data directory, or the
    current-board file.
  - Prints `Renamed board "<slug>" to "<name>".` on success.
  - Rejected when `FF_BOARD_RENAME_HERMES` is disabled.
- `kdi boards rename-slug <old-slug> <new-slug>`:
  - Retains the existing slug-rename implementation (column update, directory
    rename, current-board update).
  - Rejected when `FF_BOARD_RENAME` is disabled.
  - Continues to print the existing success/warning messages.
- Both commands reuse existing slug validation (`assertValidBoardSlug`).
- Both commands reject archived boards with the existing
  `"Board \"<slug>\" not found or is archived."` error shape.
- Help text is updated to describe the new semantics:
  - `rename` help: `Rename a board's display name (slug stays the same).`
  - `rename-slug` help: `Rename a board slug and its data directory.`

-------------------------------------------------------------------------------
Non-Functional Requirements
-------------------------------------------------------------------------------
- CLI response time remains sub-100ms.
- No filesystem operations are performed by the display-name rename path.
- No breaking change to users who have not enabled either flag.
- Existing `FF_BOARD_RENAME=true` users retain slug-rename access via the
  `rename-slug` command.

-------------------------------------------------------------------------------
Feature Flag Requirements
-------------------------------------------------------------------------------
- `ff_board_rename_hermes` registered in `src/flags.ts`:
  ```ts
  export const FF_BOARD_RENAME_HERMES = "FF_BOARD_RENAME_HERMES";
  registerFlag(FF_BOARD_RENAME_HERMES, false);
  ```
- Env var form: `FF_BOARD_RENAME_HERMES=false`.
- Defaults to `false` in every environment.
- Gated surface:
  - `kdi boards rename <slug> <name>`
- Existing `ff_board_rename` / `FF_BOARD_RENAME` continues to gate
  `kdi boards rename-slug <old-slug> <new-slug>` and is not removed.

-------------------------------------------------------------------------------
Schema Changes
-------------------------------------------------------------------------------
No schema changes are required. The `boards.name` column already exists and is
used by `updateBoardMetadata`.

-------------------------------------------------------------------------------
CLI Surface
-------------------------------------------------------------------------------
- `kdi boards rename <slug> <name>` — change display name; slug immutable.
- `kdi boards rename-slug <old-slug> <new-slug>` — move slug and data directory.

-------------------------------------------------------------------------------
Model Behavior
-------------------------------------------------------------------------------
1. Rename the existing `renameBoard(oldSlug, newSlug)` model function to
   `renameBoardSlug(oldSlug, newSlug)` to make its purpose explicit. The
   implementation (slug update, directory rename, current-board handling by the
   command layer) remains unchanged.
2. The new display-name rename reuses the existing `updateBoardMetadata` model
   function:
   ```ts
   updateBoardMetadata(slug, { name });
   ```
   This keeps validation, slug immutability, and archived-board handling in
   one place.
3. Command-layer current-board updates are only performed by `rename-slug`,
   not by display-name rename.

-------------------------------------------------------------------------------
Event Recording
-------------------------------------------------------------------------------
No new event kinds. Board rename does not record task events.

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
- [ ] `FF_BOARD_RENAME_HERMES=true kdi boards rename myproj "My Project"`
      updates `boards.name` to `"My Project"` and leaves `boards.slug` equal
      to `myproj`.
- [ ] `FF_BOARD_RENAME_HERMES=true kdi boards rename myproj "My Project"`
      does not rename the board data directory.
- [ ] `FF_BOARD_RENAME_HERMES=true kdi boards rename myproj "My Project"`
      does not modify the current-board file when it points to `myproj`.
- [ ] `FF_BOARD_RENAME_HERMES=true kdi boards rename myproj "  "` exits with
      a clear error that the name cannot be empty.
- [ ] `FF_BOARD_RENAME_HERMES=true kdi boards rename missing "Name"` exits
      with `Board "missing" not found or is archived.`
- [ ] `FF_BOARD_RENAME_HERMES=false kdi boards rename myproj "Name"` exits
      with "Board rename (Hermes semantics) feature is not enabled."
- [ ] `FF_BOARD_RENAME=true kdi boards rename-slug oldslug newslug` updates
      `boards.slug`, renames the data directory, and updates the current-board
      file when it referenced `oldslug`.
- [ ] `FF_BOARD_RENAME=false kdi boards rename-slug oldslug newslug` exits
      with "Board rename feature is not enabled."
- [ ] `kdi boards rename --help` documents `<slug> <name>` and states that the
      slug is unchanged.
- [ ] `kdi boards rename-slug --help` documents `<old-slug> <new-slug>` and
      states that the data directory is renamed.
- [ ] `kdi boards list` and `kdi boards show` reflect the updated display name
      immediately after a successful display-name rename.

-------------------------------------------------------------------------------
Risks / Open Questions
-------------------------------------------------------------------------------
- **Risk:** Users who previously enabled `FF_BOARD_RENAME=true` to get
  `kdi boards rename <old> <new>` will see that command change semantics.
  **Mitigation:** The slug-rename capability remains available as
  `kdi boards rename-slug` behind the same `FF_BOARD_RENAME` flag. Document
  the migration in release notes and help text.
- **Risk:** Existing tests for `boards rename` assume slug-rename behavior and
  will fail after the command is repurposed.
  **Mitigation:** Update tests to exercise `rename-slug` for slug-rename cases
  and add new tests for display-name rename.
- **Open question:** Should the slug-rename command be named `rename-slug`,
  `move`, or `rename-id`? This BRD proposes `rename-slug` because it is
  explicit and matches the model concept; accept or reject during review.
- **Open question:** Should display-name rename be allowed on archived boards?
  This BRD follows the existing `updateBoardMetadata` behavior and rejects
  archived boards.

-------------------------------------------------------------------------------
Migration Notes
-------------------------------------------------------------------------------
- No database migration is required.
- Add `FF_BOARD_RENAME_HERMES=false` to `src/flags.ts` and
  `specs/feature-flags.md`.
- In the command layer, repurpose the existing `boards rename` registration
  for display-name rename and add a new `boards rename-slug` registration for
  the existing slug-rename model function.
- Rename the model function `renameBoard` → `renameBoardSlug` for clarity.
- Update any internal callers or tests that invoke `renameBoard` directly to
  use `renameBoardSlug`.
- Update user-facing documentation to describe Hermes parity for `boards
  rename` and to mention `rename-slug` for identity moves.

-------------------------------------------------------------------------------
Dependencies
-------------------------------------------------------------------------------
- `src/flags.ts` (`FF_BOARD_RENAME_HERMES` registration).
- `src/commands/boards.ts` (command wiring for `rename` and `rename-slug`).
- `src/models/board.ts` (`updateBoardMetadata`, `renameBoard` →
  `renameBoardSlug`).
- `src/resolveBoard.ts` (current-board read/write, used only by `rename-slug`).
- `specs/feature-flags.md` (registry entry for `ff_board_rename_hermes`).
