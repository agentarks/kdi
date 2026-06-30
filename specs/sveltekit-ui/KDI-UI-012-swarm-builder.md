# BRD-KDI-UI-012: Swarm Builder

-------------------------------------------------------------------------------
Business Goal
-------------------------------------------------------------------------------
Give operators a browser-based way to construct and launch multi-agent swarm
graphs, mirroring the CLI's `kdi swarm` command. The builder must produce the
same orchestrator / workers / verifier / synthesizer task graph with the same
validation, expose a dry-run preview, and link to the resulting tasks in the
board view.

-------------------------------------------------------------------------------
Problem Statement
-------------------------------------------------------------------------------
KDI can create swarm graphs from the CLI (`kdi swarm --worker profile:title ...`),
but the SvelteKit operator UI has no corresponding screen. Operators who prefer
the browser must drop to the CLI to spin up parallel workers, a verifier, and a
synthesizer. This breaks the P1 operator workflow where board view, task detail,
and swarm creation should all live in the same UI.

-------------------------------------------------------------------------------
Current Behavior vs Desired Behavior
-------------------------------------------------------------------------------
| Aspect | Current | Desired |
|---|---|---|
| Swarm creation | CLI `kdi swarm --worker ... --verifier ... --synthesizer ...` | Form at `/swarm` with workers list, verifier, synthesizer, shared fields |
| Dry-run preview | CLI `--dry-run` prints text plan | UI renders the planned graph before creation |
| Worker list | Repeatable `--worker` CLI option | UI form rows with profile + title, add/remove, duplicate-title guard |
| Shared fields | `--body`, `--workspace`, `--session`, `--priority`, `--kind` | Same fields as form controls |
| Result navigation | User runs `kdi show` / `kdi list` after creation | Browser navigates to board view or task detail after creation |

-------------------------------------------------------------------------------
Scope
-------------------------------------------------------------------------------
In scope:
- A `/swarm` route in `apps/web/` with a SvelteKit form for building a swarm graph.
- A server-side `+page.server.ts` load/action that imports the existing
  `planSwarmGraph` and `createSwarmGraph` model functions from `src/models/swarm.ts`.
- A dry-run mode that returns the planned graph without mutating state.
- A create action that calls `createSwarmGraph` and returns the created task IDs.
- Validation that matches the CLI: at least one worker, required verifier and
  synthesizer, unique worker titles, `profile:title` worker format, valid workspace kind.
- Navigation to the created orchestrator detail view or back to the board view.

Out of scope (owned by other backlog items):
- KDI-UI-000: SvelteKit app shell and feature flag wiring.
- KDI-UI-001: server-side data bridge conventions; this item consumes them but adds
  the `/swarm` form only.
- KDI-UI-003: board view that links to the swarm builder.
- KDI-UI-005: task detail panel for viewing the orchestrator/children.
- KDI-UI-006: lifecycle actions on existing tasks (e.g., editing a swarm after creation).
- KDI-UI-007: dispatch control center.
- Real-time WebSockets/SSE. Polling is enough.
- Multi-user auth or permissions.
- Persisting draft swarm configurations (no new table; the form resets on reload).

-------------------------------------------------------------------------------
Dependencies
-------------------------------------------------------------------------------
- KDI-UI-000 (SvelteKit app shell) must exist and `FF_SVELTEKIT_FRONTEND` must be
  wired in `apps/web/src/hooks.server.ts`.
- KDI-UI-001 (server-side data bridge) must expose the pattern for server routes
  importing `src/models/*` and returning UI-shaped JSON. KDI-UI-012 adds the
  `/swarm` route and consumes the bridge pattern.
- Backend KDI-041 (`FF_SWARM_MODE`) must be implemented: `src/models/swarm.ts`
  exposes `planSwarmGraph` and `createSwarmGraph`, and the CLI command validates
  input the same way the UI will.
- Existing model functions: `showBoard`, `resolveBoard`, `planSwarmGraph`,
  `createSwarmGraph`, `isEnabled`, `FF_SWARM_MODE`, `FF_SVELTEKIT_FRONTEND`.

-------------------------------------------------------------------------------
Non-Goals
-------------------------------------------------------------------------------
- Editing or deleting an existing swarm graph. Once created, swarm tasks follow
  normal lifecycle actions (KDI-UI-006).
- Cloning a previous swarm graph. No new table or stored templates.
- Visual graph designer with drag-and-drop nodes. v1 is a form that matches the
  CLI's fixed worker → verifier → synthesizer topology.
- Browser-side direct access to SQLite or `src/models/*`.
- WebSocket/SSE real-time updates.
- Auth, sessions, or multi-tenant permissions.

-------------------------------------------------------------------------------
Architecture Decisions
-------------------------------------------------------------------------------
1. **Form mirrors the CLI.** The UI exposes exactly the inputs `kdi swarm` accepts
   today. Future items can add richer widgets; v1 is parity.
2. **Dry-run uses `planSwarmGraph`.** The same pure model function used by the
   CLI dry-run powers the preview, so the UI plan and CLI plan are identical.
3. **Create uses `createSwarmGraph`.** The action calls the existing transaction
   that creates the orchestrator, workers, verifier, synthesizer, dependencies,
   and events. No new backend code.
4. **Validation happens server-side.** The form posts to a SvelteKit action that
   calls `validateSwarmInput` (or lets `planSwarmGraph` throw). Error messages
   match the CLI.
5. **Result links to existing views.** After creation, the action redirects to the
   board view (`/`) so the new tasks appear immediately, or to the orchestrator
   detail (`/tasks/[id]`).
6. **No optimistic client state.** After submit, the page reloads with the action
   result; the board view is the source of truth.

-------------------------------------------------------------------------------
Resource Map
-------------------------------------------------------------------------------
Routes live under `apps/web/src/routes/` and mirror KDI-UI-001 conventions. All
response keys are camelCase.

### Page load

| Route | Method | Source | JSON shape |
|---|---|---|---|
| `/swarm` | GET | `resolveBoard` / `showBoard` | `{ board, flags }` |

`board` is the camelCase board metadata (id, slug, name). `flags` carries the
minimum needed for conditional UI: `swarmMode`, `sveltekitFrontend`.

### Form actions

| Route | Action | Source | Result |
|---|---|---|---|
| `/swarm` | `?/preview` | `planSwarmGraph` | `{ plan: SwarmPlan }` or `{ error }` |
| `/swarm` | `?/create` | `createSwarmGraph` | `{ graph: SwarmGraph }` or `{ error }` |

### Shapes

```typescript
interface SwarmPlanTask {
  title: string;
  assignee: string | null;
  status: string;
}

interface SwarmPlan {
  orchestrator: SwarmPlanTask;
  workers: SwarmPlanTask[];
  verifier: SwarmPlanTask;
  synthesizer: SwarmPlanTask;
}

interface SwarmGraph {
  orchestratorId: number;
  workerIds: number[];
  verifierId: number;
  synthesizerId: number;
}
```

The input shape posted by the browser mirrors `SwarmInput` (camelCase):

```typescript
interface SwarmFormInput {
  workers: { profile: string; title: string }[];
  verifier: string;
  synthesizer: string;
  body?: string;
  workspace?: string;
  sessionId?: string;
  priority?: number;
  kind?: "dir" | "worktree" | "scratch";
}
```

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------
- **FR-01:** A `/swarm` page exists and is reachable from the board view (KDI-UI-003)
  via a "New swarm" action. With `?board=<slug>` the page resolves the target
  board; without it, the loader uses `resolveBoard` chain (env → current file → default).
- **FR-02:** The loader returns a `404` inline error when the board is missing or archived,
  matching the CLI's `Board "..." not found or is archived.` message.
- **FR-03:** The form displays:
  - A repeatable workers section. Each worker has a profile input and a title input.
  - Buttons to add a worker row and remove any worker row.
  - A verifier profile input.
  - A synthesizer profile input.
  - A shared body textarea.
  - Shared workspace path input.
  - Shared session id input.
  - Shared priority integer input.
  - Workspace kind dropdown (`dir`, `worktree`, `scratch`).
- **FR-04:** Worker titles must be unique within the form. The UI prevents submission
  when duplicate titles are present; the server rejects duplicates with the same
  error as the CLI (`Duplicate worker title "...".`).
- **FR-05:** Each worker must be provided as `profile:title`. The UI validates the
  format locally (profile non-empty, title non-empty) and the server rejects
  malformed workers with the CLI error (`Invalid worker "...". Use --worker <profile>:<title>.`).
- **FR-06:** At least one worker, a verifier, and a synthesizer are required. The UI
  disables submission until the minimum is met; server errors mirror the CLI
  (`At least one --worker is required.`, `--verifier is required.`, `--synthesizer is required.`).
- **FR-07:** A "Preview swarm" button submits the `?/preview` action and renders the
  planned graph: orchestrator title/status, worker list with assignees, verifier
  and synthesizer, and the dependency edges (workers → verifier → synthesizer).
- **FR-08:** The preview is read-only and does not create tasks. Re-editing the form
  updates the preview on the next submit.
- **FR-09:** A "Create swarm" button submits the `?/create` action. On success, the action
  redirects to `/` (board view) with the board slug preserved, or to
  `/tasks/[orchestratorId]` with `?board=<slug>`.
- **FR-10:** On creation failure, the form redisplays with the error message and the
  previously entered values preserved.
- **FR-11:** The form supports the same workspace kinds as the CLI: `dir`, `worktree`,
  `scratch`. Invalid values are rejected with the CLI error.
- **FR-12:** The page is gated by `FF_SVELTEKIT_FRONTEND`. When the flag is off, the
  existing `hooks.server.ts` redirect to `/disabled` applies. The server action also
  returns `503 { enabled: false }` if the flag is somehow bypassed.
- **FR-13:** The swarm form itself is additionally gated by `FF_SWARM_MODE`. When the
  flag is off, the page renders a disabled message explaining that swarm mode is
  not enabled, and the create/preview actions are rejected with the same message
  as the CLI (`Swarm mode is not enabled.`).
- **FR-14:** After successful creation, a flash message or query parameter indicates
  the created orchestrator ID, e.g., `?created=42`. This is optional; navigation
  to the board view is required.
- **FR-15:** All sections handle empty/null states. The workers list starts with one
  empty worker row. Removing the last worker row leaves the form invalid until a
  new row is added.
- **FR-16:** Keyboard navigation works: focus moves naturally between worker rows,
  profile inputs are submitted as plain text, and the primary action is reachable
  via keyboard.

-------------------------------------------------------------------------------
Non-Functional Requirements
-------------------------------------------------------------------------------
- The preview action returns in under 100ms for a swarm with up to 10 workers.
- The create action completes in under 500ms for a swarm with up to 10 workers
  (bound by the existing `createSwarmGraph` transaction).
- No new runtime dependencies beyond the SvelteKit stack and existing KDI models.
- The page uses SvelteKit server-side rendering for the initial form.
- `bun run check:web` and `bun run build:web` pass with no new type errors.
- Form inputs have visible labels and accessible error announcements.

-------------------------------------------------------------------------------
Edge Cases
-------------------------------------------------------------------------------
| Scenario | Expected behavior |
|---|---|
| Board slug does not exist | `404 { error: "board_not_found" }`; form not rendered |
| Board is archived | `404 { error: "board_not_found" }`; same as CLI |
| `FF_SWARM_MODE=false` | Page shows disabled message; actions return `503 { enabled: false }` or error text |
| No workers submitted | Preview/create action returns error `At least one --worker is required.` |
| Missing verifier | Preview/create action returns error `--verifier is required.` |
| Missing synthesizer | Preview/create action returns error `--synthesizer is required.` |
| Duplicate worker titles | Preview/create action returns error `Duplicate worker title "...".` |
| Worker missing `:` or title | Preview/create action returns error `Invalid worker "...". Use --worker <profile>:<title>.` |
| Invalid workspace kind | Action returns error `Invalid --kind "...". Valid: dir, worktree, scratch.` |
| Dry-run with invalid input | Action returns validation error; no tasks created |
| Create fails mid-transaction | Existing transaction rollback in `createSwarmGraph`; UI shows generic error |
| User navigates directly to `/swarm` without `?board` | Loader resolves board via standard chain; falls back to `default` |

-------------------------------------------------------------------------------
Feature Flag Requirements
-------------------------------------------------------------------------------
- `ff_sveltekit_frontend` / `FF_SVELTEKIT_FRONTEND` (browser: `VITE_FF_SVELTEKIT_FRONTEND`),
  default `false`, gates the whole UI. Inherited from KDI-UI-000.
- `ff_swarm_mode` / `FF_SWARM_MODE`, default `false`, gates the swarm builder and
  its actions. Inherited from KDI-041.
- No new feature flag is introduced by this BRD.
- **Rollback:** set `FF_SVELTEKIT_FRONTEND=false` to hide the entire UI; set
  `FF_SWARM_MODE=false` to disable the swarm builder while leaving the rest of the
  UI available.

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
- [ ] AC-01: A `/swarm` page exists and renders a form with workers, verifier,
      synthesizer, body, workspace, session, priority, and workspace kind inputs.
- [ ] AC-02: The board view (KDI-UI-003) links to `/swarm` with the current board
      slug in the query string.
- [ ] AC-03: The loader resolves the board from `?board=<slug>` → standard chain
      → `default`, and returns a 404 error when the board is missing or archived.
- [ ] AC-04: Adding and removing worker rows works; the form starts with one empty
      worker row.
- [ ] AC-05: The form prevents submission (or the server rejects) when worker titles
      are duplicated, a worker is missing `profile:title`, or verifier/synthesizer
      are missing.
- [ ] AC-06: The "Preview swarm" action returns a planned graph matching the output
      of `kdi swarm --dry-run` for the same inputs, and creates no tasks.
- [ ] AC-07: The "Create swarm" action calls `createSwarmGraph` and creates an
      orchestrator, workers, verifier, synthesizer, and dependencies identical to
      the CLI command.
- [ ] AC-08: After successful creation, the browser redirects to the board view or
      to the orchestrator detail page.
- [ ] AC-09: When `FF_SWARM_MODE=false`, the page and actions reject with a clear
      "Swarm mode is not enabled" message.
- [ ] AC-10: When `FF_SVELTEKIT_FRONTEND=false`, the route is unavailable and the
      existing disabled screen is shown.
- [ ] AC-11: A smoke test with temp `HOME` and temp `KDI_DB` opens `/swarm`, fills
      in workers/verifier/synthesizer, previews, creates, and asserts the resulting
      tasks match `kdi swarm` output for the same inputs.
- [ ] AC-12: `bun run lint`, CLI `bun run build`, `bun run check:web`, and
      `bun run build:web` pass with an isolated `KDI_DB`.

-------------------------------------------------------------------------------
Verification Notes
-------------------------------------------------------------------------------
Implementation should prove:
- Smoke test uses temp `HOME` + temp `KDI_DB` (same pattern as `kdi-new-feature-loop`
  and `AGENTS.md` worktree isolation). Create a board via the CLI, then visit `/swarm`,
  fill the form, and click Preview. Assert the previewed titles/assignees/statuses
  match what `kdi swarm --dry-run` would print. Then click Create and assert the
  created orchestrator and child task IDs match the CLI output.
- Verify that no client module imports `~/models/*` or `bun:sqlite` by grepping
  `apps/web/.svelte-kit/output` after `bun run build:web`.
- Run `bun run lint`, `bun run build`, `bun run check:web`, and `bun run build:web`
  in the smoke environment.

-------------------------------------------------------------------------------
Migration Notes
-------------------------------------------------------------------------------
- No database migration. The form uses the existing swarm model and schema.
- No change to `src/db.ts`, `src/models/*`, `src/commands/*`, or `src/flags.ts`.

-------------------------------------------------------------------------------
STATUS.md Update Notes
-------------------------------------------------------------------------------
Add a section under the SvelteKit UI Backlog area:

```markdown
## KDI-UI-012: Swarm Builder — Spec
- [ ] BRD drafted at `specs/sveltekit-ui/KDI-UI-012-swarm-builder.md`
- [ ] `/swarm` page renders a form for workers, verifier, synthesizer, and shared fields
- [ ] Dry-run preview uses `planSwarmGraph` and matches `kdi swarm --dry-run`
- [ ] Create action uses `createSwarmGraph` and redirects to board view or orchestrator detail
- [ ] Server-side validation mirrors the CLI; gated by `FF_SWARM_MODE` and `FF_SVELTEKIT_FRONTEND`
- [ ] Smoke test with temp HOME/KDI_DB creates a swarm through the UI and asserts parity with `kdi swarm`
- [ ] `bun run lint`, CLI build, `bun run check:web`, and `bun run build:web` pass
```

-------------------------------------------------------------------------------
Spec Location
-------------------------------------------------------------------------------
`specs/sveltekit-ui/KDI-UI-012-swarm-builder.md`

-------------------------------------------------------------------------------
Worktree Branch Name
-------------------------------------------------------------------------------
`feat/kdi-ui-012-swarm-builder`

(Implementation item; implementer creates a worktree per `AGENTS.md`. Spec
authoring for this BRD is non-editing and runs in the shared checkout.)
