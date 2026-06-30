# BRD-KDI-UI-007: Dispatch Control Center

-------------------------------------------------------------------------------
Business Goal
-------------------------------------------------------------------------------
Give the SvelteKit operator UI a single control center for the dispatcher:
see whether a background dispatcher is running for the current board, how many
tasks are ready/running, whether harness profiles are healthy, and recent spawn
failures; and trigger a safe one-shot dispatch pass with the same `max`,
`failure-limit`, and `rate-limit-cooldown` controls that `kdi dispatch --once`
exposes on the CLI.

-------------------------------------------------------------------------------
Problem Statement
-------------------------------------------------------------------------------
Operators today must switch between multiple CLI commands to understand and
drive dispatch: `kdi dispatch --once --max ...` to run a pass, `kdi boards show`
for ready/running counts, `kdi profiles doctor` for harness health, and
`kdi diagnostics` / `kdi runs` to investigate spawn failures. There is no UI
screen that brings these together, so running dispatch from a browser requires
typing CLI commands in a terminal while watching the UI for status changes.

-------------------------------------------------------------------------------
Current Behavior vs Desired Behavior
-------------------------------------------------------------------------------
| Aspect | Current | Desired |
|---|---|---|
| Dispatcher state | `isDispatcherPresent()` helper / `dispatcher.pid` file | UI card shows present/absent, PID, last checked |
| Ready/running counts | `kdi boards show` or `kdi stats --json` | UI card shows live counts from `showBoard` |
| Profile health | `kdi profiles doctor --json` | UI card lists profiles and binary resolution, with bootstrap/repair hint |
| Recent spawn failures | `kdi diagnostics` / `kdi runs` per task | UI card shows latest board-level spawn/crash failures |
| One-shot dispatch | `kdi dispatch --once --max ... --failure-limit ... --rate-limit-cooldown ...` | Form + button in the UI triggers the same pass |
| Pass result | CLI prints `Dispatched (one-shot). processed=N` | UI shows processed count and refreshes counts |

-------------------------------------------------------------------------------
Scope
-------------------------------------------------------------------------------
In scope:
- A `/dispatch` page in `apps/web/` that surfaces dispatcher status, counts,
  profile health, recent spawn failures, and a one-shot dispatch form.
- Server routes/loaders that import existing KDI model helpers:
  `isDispatcherPresent`, `showBoard`, `doctorProfiles`, `bootstrapRealProfiles`,
  `tick`, and `FF_*` constants.
- A small bridge query for recent board-level spawn/crash failures (the KDI-UI-001
  bridge is extended to expose it; see Resource Map).

Out of scope (owned by other backlog items):
- KDI-UI-000: SvelteKit app shell, `FF_SVELTEKIT_FRONTEND` wiring, layout.
- KDI-UI-001: general server-side data bridge; only the narrow dispatch routes
  are defined here.
- KDI-UI-002: board management and switcher.
- KDI-UI-003: kanban board view.
- KDI-UI-006: task lifecycle actions (the dispatch form only triggers a pass).
- KDI-UI-008: live activity/event stream.
- KDI-UI-009: stats and diagnostics screens.
- Starting or stopping a long-running dispatcher daemon from the UI.
- Real-time push via WebSocket/SSE.
- Auth, sessions, or multi-tenant permissions.

-------------------------------------------------------------------------------
Dependencies
-------------------------------------------------------------------------------
- KDI-UI-000 (SvelteKit app shell) must exist and `FF_SVELTEKIT_FRONTEND` must
  be wired in `apps/web/src/hooks.server.ts`.
- KDI-UI-001 (server-side data bridge) must be able to import `src/models/*`
  and `src/dispatcher.ts` from SvelteKit server routes and return camelCase JSON.
- KDI-037 (dispatcher presence warning) must write the per-board `dispatcher.pid`
  marker so `isDispatcherPresent()` is meaningful.
- KDI-034 (dispatch controls) must add `failureLimit` to `TickOptions` and gate
  `--failure-limit` behind `FF_DISPATCH_CONTROLS`.
- KDI-056 (real harness profiles) must implement `doctorProfiles`,
  `bootstrapRealProfiles`, and `resolveCommandBinary` so the profile health card
  can be shown when `FF_REAL_HARNESS_PROFILES` is enabled.
- Existing model functions: `showBoard`, `isDispatcherPresent`, `doctorProfiles`,
  `bootstrapRealProfiles`, `tick`, and `FF_*` flag helpers from `src/flags.ts`.

-------------------------------------------------------------------------------
Non-Goals
-------------------------------------------------------------------------------
- A daemon start/stop panel. The UI only triggers one-shot passes and reads
  the presence marker for a dispatcher that was started elsewhere (CLI).
- Task-level lifecycle actions (promote, block, assign, etc.).
- A separate service or proxy between the UI and the models.
- WebSocket/SSE real-time updates (polling is sufficient for v1).
- Auth, sessions, or multi-tenant permissions.
- Inline log parsing or rich failure diagnostics.

-------------------------------------------------------------------------------
Architecture Decisions
-------------------------------------------------------------------------------
1. **Direct model call for one-shot dispatch.** The server action calls `tick()`
   directly from `src/dispatcher.ts` with the same options the CLI would pass.
   This avoids spawning the CLI binary from a SvelteKit route and keeps the UI
   on the same `getDb()` singleton as the bridge. Spawning the `kdi` binary is
   rejected because it violates the KDI-UI-001 bridge principle.
2. **Read-only presence indicator.** The UI reads `isDispatcherPresent()`; it
   does not write `dispatcher.pid` itself. A one-shot pass is not a daemon and
   does not mark itself as "present."
3. **Poll for state, not push.** Presence, counts, and profile health are polled
   every 5 seconds by default. No WebSocket/SSE server is introduced.
4. **Board-scoped view.** The page reads `?board=<slug>` or falls back to the
   current board → `"default"`, matching the UI subset of `resolveBoard` used by
   other KDI-UI screens.
5. **Profile health is optional.** The profile card renders only when
   `FF_REAL_HARNESS_PROFILES` is enabled. When disabled, the section is hidden
   so the UI does not advertise a feature that is not backed by the CLI.
6. **Failure card from `task_runs`.** Recent spawn/crash failures are fetched by
   a board-level query against `task_runs` joined with `tasks`. This is the only
   new query introduced by the dispatch control center; the KDI-UI-001 bridge
   exposes it as a route so the UI does not write SQL directly.

-------------------------------------------------------------------------------
Resource Map
-------------------------------------------------------------------------------
Routes live under `apps/web/src/routes/api/`. All response keys are camelCase.

### Dispatch status snapshot

| Route | Method | Source | JSON shape |
|---|---|---|---|
| `/api/boards/[slug]/dispatch/status` | GET | `showBoard`, `isDispatcherPresent`, `doctorProfiles`, `getRecentBoardRunFailures` | `DispatchStatus` |

`DispatchStatus`:
```typescript
interface DispatchStatus {
  board: string;
  presence: {
    present: boolean;
    pid: number | null;
    checkedAt: number; // unix epoch seconds
  };
  taskCounts: BoardTaskCounts; // from showBoard: triage, todo, scheduled, ready, running, blocked, review, done, archived
  profiles: {
    enabled: boolean;      // FF_REAL_HARNESS_PROFILES
    path: string;          // defaultProfilesPath()
    entries: ProfileHealth[];
  };
  recentFailures: {
    enabled: boolean;      // true when the bridge route is implemented
    failures: SpawnFailure[];
  };
  flags: {
    canDispatch: boolean;         // FF_ENABLE_KANBAN_DISPATCH && FF_DISPATCH_ONCE
    canUseFailureLimit: boolean;  // FF_DISPATCH_CONTROLS
    canUseRateLimitCooldown: boolean; // FF_RATE_LIMIT_EXIT_CODE
    canShowProfiles: boolean;     // FF_REAL_HARNESS_PROFILES
  };
}

interface ProfileHealth {
  name: string;
  agent: string | undefined;
  command: string;
  binary: string;
  resolvedPath: string | null;
  ok: boolean;
  status: "ok" | "missing-binary";
}

interface SpawnFailure {
  runId: number;
  taskId: number;
  taskTitle: string;
  profile: string | null;
  outcome: "spawn_failed" | "crashed" | "failed";
  error: string | null;
  startedAt: number;
}
```

The `getRecentBoardRunFailures(boardId, limit = 10)` query returns the most
recent `task_runs` rows for the board whose `outcome` is `spawn_failed` or
`crashed`, joined with `tasks` to get the title, ordered by `started_at DESC`.

### One-shot dispatch

| Route | Method | Source | JSON shape |
|---|---|---|---|
| `/api/boards/[slug]/dispatch` | POST | `tick()` | `DispatchOnceResult` |

POST body:
```typescript
interface DispatchTrigger {
  max: number;                    // non-negative; 0 = unlimited
  failureLimit?: number;          // positive; only sent when FF_DISPATCH_CONTROLS
  rateLimitCooldown?: string;     // duration string e.g. "60s"; only sent when FF_RATE_LIMIT_EXIT_CODE
}
```

`DispatchOnceResult`:
```typescript
interface DispatchOnceResult {
  processed: number;  // tasks that reached a terminal state (done/blocked/failed)
  spawned: number;    // harnesses that were started
  blocked: number;    // tasks that became blocked this pass
  skipped: number;    // tasks skipped because of unknown profile, missing binary, or dependencies
  failed: number;     // tasks that failed/crashed this pass
}
```

The server action validates the body, rejects when `FF_ENABLE_KANBAN_DISPATCH`
or `FF_DISPATCH_ONCE` is disabled, parses the duration string with `parseDuration`
into seconds, and calls `tick({ boardId, boardSlug, maxSpawnsPerTick: max,
rateLimitCooldownSeconds, failureLimit })`. It returns the full breakdown. The
backend `TickResult` type must be extended to include `spawned`, `blocked`,
`skipped`, and `failed` so the UI can surface the per-outcome counts without
re-querying the board.

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------
- **FR-01:** A `/dispatch` page exists in the SvelteKit UI. It is reachable from
  the left navigation and the board view (KDI-UI-003).
- **FR-02:** The page loads the board via `?board=<slug>`; if omitted, it falls
  back to `readCurrentBoard()` → `"default"`. A missing or archived board renders
  an inline `Board "..." not found.` error; the app shell is still rendered.
- **FR-03:** The page header shows the board slug/name and a "last refreshed"
  timestamp.
- **FR-04:** The dispatcher presence card shows:
  - A status badge ("Running" / "Not detected").
  - The PID when present and parsable.
  - The last checked timestamp.
  - A manual refresh button.
- **FR-05:** The presence card polls `isDispatcherPresent()` every 5 seconds and
  updates the badge/timestamp without a full page reload. Polling pauses when
  the page is hidden and resumes when visible.
- **FR-06:** The counts card shows the 9 `taskCounts` buckets from `showBoard`:
  `triage`, `todo`, `scheduled`, `ready`, `running`, `blocked`, `review`, `done`,
  `archived`. The `ready` and `running` counts are emphasized.
- **FR-07:** The counts card refreshes every 5 seconds (same poll as presence) and
  after a successful dispatch trigger.
- **FR-08:** The profile health card renders only when
  `FF_REAL_HARNESS_PROFILES=true`. It lists every profile returned by
  `doctorProfiles()`, showing name, command, binary, resolved path, and status.
  Missing binaries are highlighted with a warning icon and a hint to run
  `kdi profiles bootstrap` or `kdi profiles doctor`.
- **FR-09:** The profile health card offers a "Bootstrap profiles" button that
  calls `bootstrapRealProfiles(path, false)` and refreshes the profile list on
  success. A secondary "Force bootstrap" option (e.g. a checkbox) calls
  `bootstrapRealProfiles(path, true)`. When the flag is off, the entire card is
  absent (not greyed).
- **FR-10:** The recent spawn failures card renders only when the bridge route
  is implemented. It shows up to 10 failures with task id, title, profile,
  outcome, error, and started time. Each task id links to the task detail page
  (KDI-UI-005). When there are no failures, it shows a clear empty state.
- **FR-11:** The dispatch control form contains:
  - `max` — non-negative integer input; default `0` (unlimited); always visible.
  - `failureLimit` — positive integer input; visible and enabled only when
    `FF_DISPATCH_CONTROLS=true`.
  - `rateLimitCooldown` — duration string input (e.g. `60s`, `5m`, `1h`);
    visible and enabled only when `FF_RATE_LIMIT_EXIT_CODE=true`.
  - A "Run one-shot dispatch" submit button.
- **FR-12:** The submit button is disabled and a warning is shown when
  `FF_ENABLE_KANBAN_DISPATCH=false` or `FF_DISPATCH_ONCE=false`. When both flags
  are on, the button is enabled and submits to the server action.
- **FR-13:** The server action re-checks the flags, validates `max >= 0`,
  `failureLimit > 0` (when present), and parses `rateLimitCooldown` with
  `parseDuration`. Invalid input returns a `400` with a stable error code.
- **FR-14:** On success, the server action returns a `DispatchOnceResult` with
  `processed`, `spawned`, `blocked`, `skipped`, and `failed` counts. The UI shows
  the breakdown, highlights any non-zero blocked/skipped/failed counts, and
  refreshes the counts and presence cards. On failure, the UI shows the error
  inline without losing the form values.
- **FR-15:** When the board has no ready tasks, the form is still available but
  the result will be `processed=0`. The UI shows a hint that no tasks are ready.
- **FR-16:** Server routes return `503 { enabled: false }` when
  `FF_SVELTEKIT_FRONTEND=false`, consistent with the rest of the UI.

-------------------------------------------------------------------------------
Non-Functional Requirements
-------------------------------------------------------------------------------
- The dispatch status snapshot route returns in under 100ms for a board with
  <1,000 tasks and <50 recent failures.
- Poll interval is 5 seconds by default; the UI allows 2–30 seconds and clamps
  out-of-range values.
- The one-shot dispatch action waits for `tick()` to finish; it does not spawn a
  background job. The UI shows a loading spinner while the pass runs.
- No new runtime dependencies beyond the SvelteKit stack and existing KDI models.
- The page server-renders the initial empty state and header; the status data is
  fetched client-side after hydration or via the server load.
- `bun run check:web` and `bun run build:web` pass with no new type errors.

-------------------------------------------------------------------------------
Edge Cases
-------------------------------------------------------------------------------
| Scenario | Expected behavior |
|---|---|
| Board slug does not exist | `404 { error: "board_not_found" }`; UI shows board not found |
| `dispatcher.pid` is missing | Presence badge shows "Not detected" |
| `dispatcher.pid` contains a dead PID | Presence badge shows "Not detected" (defensive stale-marker handling) |
| `dispatcher.pid` is malformed | Presence badge shows "Not detected" |
| No ready tasks | Counts show `ready: 0`; dispatch result is `processed: 0` |
| No profiles file | `doctorProfiles()` falls back to built-ins; UI shows built-in profiles |
| All profiles healthy | Profile card shows all green; bootstrap button is available but no-op if run without force |
| `FF_REAL_HARNESS_PROFILES=false` | Profile card is hidden |
| `FF_DISPATCH_CONTROLS=false` | Failure-limit input is hidden |
| `FF_RATE_LIMIT_EXIT_CODE=false` | Rate-limit-cooldown input is hidden |
| `FF_ENABLE_KANBAN_DISPATCH=false` | Submit button disabled; server rejects with feature disabled message |
| `FF_DISPATCH_ONCE=false` | Submit button disabled; server rejects with feature disabled message |
| `tick()` throws | Server returns `500 { error: "dispatch_failed" }`; UI shows inline error |
| Invalid `failureLimit` (0 or non-integer) | Client rejects before submit; server returns `400 { error: "invalid_failure_limit" }` |
| Invalid `rateLimitCooldown` | Server returns `400 { error: "invalid_duration" }` |
| Page is hidden | Polling pauses; resumes when visible |
| Bridge route for recent failures not implemented | Card shows "Not available" placeholder |

-------------------------------------------------------------------------------
Feature Flag Requirements
-------------------------------------------------------------------------------
Gated by the same `ff_sveltekit_frontend` / `FF_SVELTEKIT_FRONTEND` flag
(registered in `specs/feature-flags.md`, default `false`). Browser detection of
enabled state uses `VITE_FF_SVELTEKIT_FRONTEND` once client code exists.

Sub-features also respect their existing backend flags:
- `FF_ENABLE_KANBAN_DISPATCH` — the whole dispatch trigger; when off the form is
  disabled and the server rejects the POST.
- `FF_DISPATCH_ONCE` — one-shot dispatch trigger; when off the form is disabled
  because the UI only supports one-shot passes.
- `FF_DISPATCH_CONTROLS` — `failure-limit` input.
- `FF_RATE_LIMIT_EXIT_CODE` — `rate-limit-cooldown` input.
- `FF_REAL_HARNESS_PROFILES` — profile health/repair card.

No new feature flag is introduced by this BRD.

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
- [ ] AC-01: A `/dispatch` page exists and renders the board header, dispatcher
      presence card, counts card, profile card, recent failures card, and
      dispatch control form.
- [ ] AC-02: The board view (KDI-UI-003) and left navigation link to the dispatch
      page.
- [ ] AC-03: `GET /api/boards/[slug]/dispatch/status` returns `DispatchStatus`
      with board, presence, task counts, profile health, and recent failures.
- [ ] AC-04: The presence card shows "Running" when a live `dispatcher.pid`
      exists and "Not detected" otherwise.
- [ ] AC-05: The counts card matches the `taskCounts` from `showBoard` for the
      same board.
- [ ] AC-06: When `FF_REAL_HARNESS_PROFILES=true`, the profile card lists all
      profiles from `doctorProfiles()` and marks missing binaries with a
      warning.
- [ ] AC-07: When `FF_REAL_HARNESS_PROFILES=false`, the profile card is absent.
- [ ] AC-08: The "Bootstrap profiles" button calls `bootstrapRealProfiles(false)`
      and refreshes the profile list; "Force bootstrap" calls it with `true`.
- [ ] AC-09: The recent failures card shows up to 10 latest `spawn_failed` /
      `crashed` runs for the board, with links to task detail pages.
- [ ] AC-10: The dispatch form exposes `max` always, `failureLimit` only when
      `FF_DISPATCH_CONTROLS=true`, and `rateLimitCooldown` only when
      `FF_RATE_LIMIT_EXIT_CODE=true`.
- [ ] AC-11: Submitting the form triggers a server action that calls `tick()`
      and returns `processed`, `spawned`, `blocked`, `skipped`, and `failed`
      counts; the UI shows the breakdown and refreshes the counts card.
- [ ] AC-12: With `FF_ENABLE_KANBAN_DISPATCH=false` or `FF_DISPATCH_ONCE=false`,
      the submit button is disabled and the server rejects the POST with a clear
      feature-disabled message.
- [ ] AC-13: Invalid `max`, `failureLimit`, or `rateLimitCooldown` values are
      rejected with stable error codes before `tick()` is invoked.
- [ ] AC-14: Polling pauses when the page is hidden and resumes when visible.
- [ ] AC-15: When `FF_SVELTEKIT_FRONTEND=false`, the page shows the disabled
      screen and routes return `503 { enabled: false }`.
- [ ] AC-16: A smoke test with temp `HOME` and temp `KDI_DB` creates a board and
      a ready task via the CLI, opens `/dispatch`, asserts the counts show
      `ready: 1`, runs the one-shot dispatch form, and asserts the count becomes
      `running: 1` or `done: 1` depending on the test harness.
- [ ] AC-17: `bun run lint`, `bun run build` (CLI), `bun run check:web`, and
      `bun run build:web` all pass with an isolated `KDI_DB`.

-------------------------------------------------------------------------------
Verification Notes
-------------------------------------------------------------------------------
Implementation should prove:
- Smoke test uses temp `HOME` + temp `KDI_DB` (same pattern as
  `kdi-new-feature-loop` and `AGENTS.md` worktree isolation). Create a board
  and a task via the CLI, visit `/dispatch`, assert the board is resolved, the
  counts card shows the expected ready count, and the presence card shows
  "Not detected" before any dispatcher is started.
- Trigger the one-shot dispatch form with `max=0` and assert the server action
  returns a breakdown of `processed`, `spawned`, `blocked`, `skipped`, and
  `failed` counts and the counts card updates (e.g. `running` or `done` changes).
- Verify the profile health card with `FF_REAL_HARNESS_PROFILES=true` and a
  stale profile path; assert the missing binary is flagged and the bootstrap
  button repairs it.
- Verify that no client module imports `~/models/*` or `bun:sqlite` by running
  `bun run build:web` and grepping `apps/web/.svelte-kit/output` or equivalent.
- Run `bun run lint`, `bun run build`, `bun run check:web`, and `bun run build:web`
  in the smoke environment.

-------------------------------------------------------------------------------
Risks / Open Questions
-------------------------------------------------------------------------------
- **Risk: `tick()` runs in the SvelteKit server process and may be long-lived.**
  A one-shot pass can claim and spawn harnesses that run up to
  `max_runtime_seconds`. The request will block. **Mitigation:** this is the same
  behavior as `kdi dispatch --once`; the UI shows a loading spinner and the form
  is disabled while the pass runs. If the product later needs non-blocking
  dispatch, a background job queue would be a separate BRD.
- **Risk: DB contention with a separate CLI dispatcher.** The UI server process
  and a `kdi dispatch` daemon could point at the same DB file. SQLite WAL makes
  writes safe, but the UI can show transiently stale state between polls.
  **Mitigation:** document that the UI should run against a DB not actively
  driven by a CLI dispatcher, or accept poll lag; do not add locking in the UI.
- **Risk: new query for recent failures.** The KDI-UI-001 bridge currently does
  not expose board-level run-failure queries. **Mitigation:** the bridge route
  adds the narrow query; if it is not implemented, the UI shows a placeholder
  and the rest of the screen works.
- **Open question:** Should the UI allow starting a background dispatcher
  daemon? This BRD says no; the UI only triggers one-shot passes and reads the
  presence marker. If product wants daemon control, that is a follow-up item.
- **Open question:** Should the profile card show only the profiles used by the
  current board's ready tasks, or all loaded profiles? This BRD recommends all
  loaded profiles (what `doctorProfiles` returns) because dispatch can pick any
  profile. The implementer may narrow it if the list is large.
- **Open question:** Should the dispatch form remember the last `max`,
  `failureLimit`, and `rateLimitCooldown` values? This BRD leaves it to the
  implementer; persistence is not required for v1.

-------------------------------------------------------------------------------
Migration Notes
-------------------------------------------------------------------------------
- No database migration. The dispatch control center uses existing schema,
  models, and the dispatcher presence marker.
- No change to `src/db.ts`. `getDb()` resolution from `KDI_DB`/`KDI_DB_PATH` is
  inherited from the server process.
- `src/dispatcher.ts` `TickResult` type is extended to include `spawned`,
  `blocked`, `skipped`, and `failed` counts so the one-shot action can return the
  full breakdown to the UI. No other changes to `src/dispatcher.ts` or
  `src/dispatcherPresence.ts` are required beyond importing their existing exports.

-------------------------------------------------------------------------------
STATUS.md Update Notes
-------------------------------------------------------------------------------
Add a section under the SvelteKit UI Backlog area:

```markdown
## KDI-UI-007: Dispatch Control Center — Spec
- [ ] BRD drafted at `specs/sveltekit-ui/KDI-UI-007-dispatch-control-center.md`
- [ ] `/dispatch` page renders dispatcher presence, ready/running counts, profile
      health, recent spawn failures, and a one-shot dispatch form
- [ ] Server action calls `tick()` directly with `max`, `failureLimit`, and
      `rateLimitCooldown` options; returns spawned/blocked/skipped/failed/processed
      breakdown
- [ ] Profile health/repair card gated by `FF_REAL_HARNESS_PROFILES`
- [ ] Smoke test with temp HOME/KDI_DB creates a ready task and triggers one-shot
      dispatch from the UI, asserting the counts update
- [ ] `bun run lint`, CLI build, `bun run check:web`, and `bun run build:web` pass
```

-------------------------------------------------------------------------------
Spec Location
-------------------------------------------------------------------------------
`specs/sveltekit-ui/KDI-UI-007-dispatch-control-center.md`

-------------------------------------------------------------------------------
Worktree Branch Name
-------------------------------------------------------------------------------
`feat/kdi-ui-007-dispatch-control-center`

(Implementation item; implementer creates a worktree per `AGENTS.md`. Spec
authoring for this BRD is non-editing and runs in the shared checkout.)
