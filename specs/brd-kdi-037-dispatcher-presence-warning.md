# BRD-KDI-037: Dispatcher Presence Warning

-------------------------------------------------------------------------------
Business Goal
-------------------------------------------------------------------------------
Help operators notice when they are creating tasks while no dispatcher is
running for the target board. A silent, non-running dispatcher leaves ready
tasks stranded; a warning at creation time gives immediate feedback without
blocking the operator's workflow.

-------------------------------------------------------------------------------
User Stories
-------------------------------------------------------------------------------
1. As an operator, I get a warning on stderr when I run `kdi create` and no
   live dispatcher is detected for the target board.
2. As an operator, I can suppress the warning for a single invocation with
   `kdi create --no-dispatcher-warning`.
3. As an operator, the warning is defensive: a missing, stale, unreadable, or
   invalid PID file is treated as "no dispatcher detected" and warns.
4. As a maintainer, I can disable the probe entirely so `kdi create` behaves
   exactly as it did before this feature.

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------
- `kdi create <title>` resolves the target board via the standard chain:
  `--board` → `KDI_BOARD` env → current file → `default`, exactly as today.
- When the feature flag is enabled and `--no-dispatcher-warning` is not
  supplied, `kdi create` probes for a live dispatcher after the board is
  resolved and before the task is created.
- The probe reads the board's dispatcher PID file
  `<boardDataDir>/dispatcher.pid` and checks whether the stored PID refers to
  a live process on the local machine.
- The probe returns "present" only when:
  - the PID file exists and is readable,
  - it contains a single valid positive integer, and
  - `process.kill(pid, 0)` succeeds (the process is alive).
- Any other condition (missing file, unreadable file, empty file, malformed
  content, or dead PID) is treated as "not present" and triggers a warning.
- The warning is printed to stderr as a single line, for example:
  ```
  Warning: No running dispatcher detected for board "myproj". Tasks may not be picked up until one starts.
  ```
- The warning is non-blocking: task creation proceeds normally, the new task
  ID is printed to stdout, and the command exits with code `0`.
- When a dispatcher is detected, `kdi create` prints nothing extra and exits
  with code `0`.
- `kdi create --no-dispatcher-warning` skips the probe and emits no warning
  for that invocation, even when the feature flag is enabled.
- When the feature flag is disabled, `kdi create` performs no probe, emits no
  warning, and ignores `--no-dispatcher-warning`.
- The dispatcher writes a per-board PID marker when it starts and removes it
  when it exits cleanly. The marker is written for every active board at
  startup and lazily for any board the dispatcher first touches after startup
  (e.g. a board created while the dispatcher is running).

-------------------------------------------------------------------------------
Non-Functional Requirements
-------------------------------------------------------------------------------
- CLI response time for `kdi create` remains sub-100ms; the probe is a local
  filesystem read plus a single PID liveness check.
- No breaking change to `kdi create` output or exit behavior when the flag is
  disabled.
- Probe failures must never cause `kdi create` to fail or exit non-zero.
- No database schema changes are required.

-------------------------------------------------------------------------------
Feature Flag Requirements
-------------------------------------------------------------------------------
- `ff_dispatcher_presence_warning` registered in `src/flags.ts`:
  ```ts
  export const FF_DISPATCHER_PRESENCE_WARNING = "FF_DISPATCHER_PRESENCE_WARNING";
  registerFlag(FF_DISPATCHER_PRESENCE_WARNING, false);
  ```
- Env var form: `FF_DISPATCHER_PRESENCE_WARNING=false`.
- Defaults to `false` in every environment.
- When disabled, `kdi create` performs no probe and emits no warning.
- When enabled, `kdi create` probes unless `--no-dispatcher-warning` is set.
- Add the flag to the registry in `specs/feature-flags.md` with status
  `InDev`, scope `CLI / dispatcher + create`, and BRD link
  `specs/brd-kdi-037-dispatcher-presence-warning.md`.

-------------------------------------------------------------------------------
Schema / State Changes
-------------------------------------------------------------------------------
No database schema changes are required.

A new runtime state file is introduced:
- Path: `<boardDataDir>/dispatcher.pid`
- `boardDataDir` is produced by `getBoardDataDir(slug)` in `src/db.ts`, which
  resolves to `~/.local/share/kdi/boards/<slug>` by default and honors the
  `KDI_DB` / `KDI_DB_PATH` environment variables.
- Content: a single line containing the dispatcher process PID.
- Lifecycle:
  - Created when the dispatcher starts (for all active boards) and lazily
    when the dispatcher first processes a board.
  - Removed when the dispatcher exits cleanly.
  - Left behind on unclean exit; the defensive liveness check in
    `isDispatcherPresent()` treats stale markers as "not present".

-------------------------------------------------------------------------------
CLI Surface
-------------------------------------------------------------------------------
- `kdi create <title> ... [--no-dispatcher-warning]` — create a task;
  optionally suppress the dispatcher presence warning.
- `kdi dispatch [--interval <ms>] [--max <n>] ...` — unchanged options, but
  the command now writes per-board PID markers at startup and removes them on
  clean shutdown.

-------------------------------------------------------------------------------
Model / Helper Behavior
-------------------------------------------------------------------------------
Add a new helper module `src/dispatcherPresence.ts` with the following
functions:

1. `getDispatcherPidPath(boardSlug: string): string`
   - Returns `join(getBoardDataDir(boardSlug), "dispatcher.pid")`.

2. `isDispatcherPresent(boardSlug: string): boolean`
   - Resolves the PID file path.
   - Returns `false` if the file is missing, unreadable, empty, or does not
     contain a single positive integer.
   - Parses the PID and returns the result of `process.kill(pid, 0)`.
   - Returns `false` for any exception.

3. `ensureDispatcherPid(boardSlug: string): void`
   - Creates the board data directory if necessary.
   - Writes `process.pid` to `<boardDataDir>/dispatcher.pid`.
   - Tracks the slug in a module-level `Set<string>` so it can be cleaned up
     on exit.

4. `clearAllDispatcherPids(): void`
   - Iterates the tracked slugs and removes each corresponding PID file.
   - Swallows errors so cleanup failures do not prevent dispatcher shutdown.
   - Clears the tracked set.

`src/dispatcher.ts`:
- `startDispatcher` seeds markers before entering the poll loop:
  - Query active boards via `listBoards(false)` from `src/models/board.ts`.
  - Call `ensureDispatcherPid(board.slug)` for each active board.
- During `tick()`, lazily call `ensureDispatcherPid(slug)` for any board slug
  resolved while processing ready tasks or notifier watchers, if that slug is
  not already tracked.
- `DispatcherHandle.stop()` calls `clearAllDispatcherPids()` synchronously
  before awaiting the loop to exit, ensuring markers are removed on both
  normal and signal-driven shutdown.

`src/models/board.ts`:
- Reuse the existing `listBoards(includeArchived = false)` helper; no new
  board model surface is required.

-------------------------------------------------------------------------------
Command Handler Behavior
-------------------------------------------------------------------------------
### `kdi create`
1. Add the option:
   ```ts
   .option("--no-dispatcher-warning", "Suppress the dispatcher presence warning")
   ```
2. Resolve the board slug and fetch the board object as today.
3. If `isEnabled(FF_DISPATCHER_PRESENCE_WARNING)` is true and
   `options.noDispatcherWarning` is not set, call
   `isDispatcherPresent(board.slug)`.
4. If the probe returns `false`, print the warning line to stderr with
   `console.warn`.
5. Proceed with `createTask(...)` exactly as today and print the new task ID
   to stdout.
6. Exit with code `0`.

### `kdi dispatch`
1. No new CLI options.
2. Continue calling `startDispatcher(interval, options)`.
3. `startDispatcher` now seeds per-board PID markers and removes them on
   `stop()`.
4. The existing `SIGINT`/`SIGTERM` handlers in `dispatchCommand` call
   `dispatcher.stop()`, which triggers marker cleanup.

-------------------------------------------------------------------------------
Behavior and Edge Cases
-------------------------------------------------------------------------------
| Scenario | Expected behavior |
|---|---|
| Flag disabled | `kdi create` performs no probe and prints no warning. `--no-dispatcher-warning` is accepted but has no effect. |
| Flag enabled, dispatcher alive for board | No extra output; task ID printed to stdout; exit `0`. |
| Flag enabled, no PID file | Warning to stderr; task created; task ID to stdout; exit `0`. |
| Flag enabled, PID file contains dead PID | Warning to stderr (defensive stale-marker handling). |
| Flag enabled, PID file is empty or non-numeric | Warning to stderr. |
| Flag enabled, PID file exists but is unreadable | Warning to stderr; task creation still succeeds. |
| `--no-dispatcher-warning` with flag enabled | No probe, no warning, normal creation. |
| Dispatcher exits cleanly | All tracked PID files are removed. |
| Dispatcher crashes or is SIGKILLed | PID files remain; `isDispatcherPresent` detects dead PID and warns. |
| Board created after dispatcher started | Marker is written lazily on first tick that touches the board. |
| Multiple dispatchers running | Last writer wins; if the stored PID is alive, the probe reports present. |
| PID reuse by an unrelated process | Probe returns present (best-effort limitation of PID files). |
| `KDI_DB` relocates the database | Marker path follows `defaultDbPath()` via `getBoardDataDir`, staying consistent with board data. |

-------------------------------------------------------------------------------
Test Plan
-------------------------------------------------------------------------------
### Unit tests (`tests/dispatcherPresence.test.ts`)
- `getDispatcherPidPath()` returns a path under the board data directory.
- `isDispatcherPresent()` returns `false` when the PID file is missing.
- `isDispatcherPresent()` returns `false` when the PID file is empty.
- `isDispatcherPresent()` returns `false` when the PID file contains non-numeric text.
- `isDispatcherPresent()` returns `false` when the PID file contains a dead PID.
- `isDispatcherPresent()` returns `true` when the PID file contains the current
  process PID.
- `ensureDispatcherPid()` creates the board data directory and writes the
  current PID.
- `clearAllDispatcherPids()` removes all tracked PID files.

### CLI / integration tests (`tests/commands/tasks.test.ts`)
- `FF_DISPATCHER_PRESENCE_WARNING=false kdi create ...` emits no warning and
  creates the task.
- `FF_DISPATCHER_PRESENCE_WARNING=true kdi create ...` with no marker emits
  the warning to stderr, the task ID to stdout, and exits `0`.
- `FF_DISPATCHER_PRESENCE_WARNING=true kdi create ...` with a live-PID marker
  emits no warning.
- `FF_DISPATCHER_PRESENCE_WARNING=true kdi create ...` with a dead-PID marker
  emits the warning.
- `FF_DISPATCHER_PRESENCE_WARNING=true kdi create ... --no-dispatcher-warning`
  emits no warning even when no marker exists.
- Existing `kdi create` option combinations continue to work unchanged.

### Dispatcher integration tests
- `kdi dispatch` seeds PID markers for all active boards before the first tick.
- `dispatcher.stop()` removes all seeded PID markers.
- A dispatcher that touches a new board during a tick writes a marker for that
  board.

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
- [ ] Feature flag `ff_dispatcher_presence_warning` / `FF_DISPATCHER_PRESENCE_WARNING`
      is registered in `src/flags.ts` and `specs/feature-flags.md`, defaulting
      to `false`.
- [ ] `FF_DISPATCHER_PRESENCE_WARNING=true kdi create "task" --board myproj`
      with no dispatcher running prints a warning to stderr, prints the new
      task ID to stdout, and exits `0`.
- [ ] `FF_DISPATCHER_PRESENCE_WARNING=true kdi create "task" --board myproj`
      with a live dispatcher for `myproj` prints no warning and exits `0`.
- [ ] `FF_DISPATCHER_PRESENCE_WARNING=true kdi create "task" --board myproj`
      with a stale or unreadable PID file prints the warning and still creates
      the task.
- [ ] `FF_DISPATCHER_PRESENCE_WARNING=true kdi create "task" --board myproj
      --no-dispatcher-warning` prints no warning and creates the task.
- [ ] `FF_DISPATCHER_PRESENCE_WARNING=false kdi create "task" --board myproj`
      behaves exactly as before (no probe, no warning, ignores
      `--no-dispatcher-warning`).
- [ ] `kdi dispatch` writes a `dispatcher.pid` file for each active board at
      startup and removes all tracked files on clean shutdown.
- [ ] The dispatcher lazily writes a marker for any board it first touches
      after startup.
- [ ] Unit tests cover `dispatcherPresence.ts` helpers for missing, malformed,
      dead, and live PID cases.
- [ ] CLI tests cover flag gating, warning emission, suppression, and stale
      marker handling.
- [ ] `bun run lint`, `bun run test`, and `bun run build` pass.

-------------------------------------------------------------------------------
Risks / Open Questions
-------------------------------------------------------------------------------
- **Risk:** A stale PID file left by a crashed dispatcher will warn until the
  dispatcher restarts or the file is removed. **Mitigation:** the liveness
  check treats dead PIDs as "not present"; clean shutdown removes the file.
- **Risk:** PID reuse by an unrelated process can make a stale marker appear
  alive. **Mitigation:** document that the probe is best-effort; future work
  could store additional metadata (e.g. process start time or command line).
- **Risk:** The dispatcher is global but markers are per-board; a board created
  after startup will lack a marker until the dispatcher touches it. **Mitigation:**
  seed markers for all active boards at startup and lazily write markers for
  any board encountered in `tick()`.
- **Risk:** Writing markers inside the dispatcher tick loop adds filesystem
  I/O. **Mitigation:** track written slugs in memory and write each marker only
  once per process.
- **Open question:** Should the warning be suppressible globally via an
  environment variable (e.g. `KDI_NO_DISPATCHER_WARNING=1`)? Out of scope; the
  per-invocation `--no-dispatcher-warning` flag and the feature flag provide
  the primary controls.
- **Open question:** Should `kdi create` warn only when the initial status is
  `ready` or `todo`, and not for `done`, `blocked`, etc.? Out of scope for this
  BRD; the warning is board-level and independent of the chosen initial status.

-------------------------------------------------------------------------------
Dependencies
-------------------------------------------------------------------------------
- `src/flags.ts` (`FF_DISPATCHER_PRESENCE_WARNING`).
- `src/commands/tasks.ts` (`createTaskCommand` option and probe).
- `src/commands/dispatch.ts` (`SIGINT`/`SIGTERM` handlers already call
  `dispatcher.stop()`).
- `src/dispatcher.ts` (`startDispatcher` seed/lazy markers, `stop` cleanup).
- `src/dispatcherPresence.ts` (new helper module).
- `src/db.ts` (`getBoardDataDir` for marker path resolution).
- `src/models/board.ts` (`listBoards` for seeding active-board markers).
- `specs/feature-flags.md` (registry entry).

-------------------------------------------------------------------------------
STATUS.md Update Notes
-------------------------------------------------------------------------------
Add a new section under the feature list:

```markdown
## Dispatcher Presence Warning (KDI-037) — In Progress
- [ ] BRD drafted at `specs/brd-kdi-037-dispatcher-presence-warning.md`
- [ ] Feature flag `ff_dispatcher_presence_warning` / `FF_DISPATCHER_PRESENCE_WARNING`
      registered in `src/flags.ts` and `specs/feature-flags.md`, defaults to `false`
- [ ] `kdi create <title> [--no-dispatcher-warning]` option implemented
- [ ] Dispatcher writes per-board `dispatcher.pid` marker at startup and removes
      it on clean shutdown
- [ ] `kdi create` warns on stderr when no live dispatcher is detected for the
      target board
- [ ] Unit/CLI tests cover flag gating, live/dead/missing PID, and suppression
      option
- [ ] `bun run lint`, `bun run test`, `bun run build` pass
```

Also add a note to the Dispatcher — Accepted section:
```markdown
- [ ] Dispatcher writes per-board PID markers and `kdi create` warns when no
      live dispatcher is detected (KDI-037)
```
