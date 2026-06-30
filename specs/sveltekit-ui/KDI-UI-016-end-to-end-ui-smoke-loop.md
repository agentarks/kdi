# Specification: KDI-UI-016 — End-to-end UI Smoke Loop

> Parent backlog: `specs/sveltekit-ui-backlog.md` → `KDI-UI-016: End-to-end UI smoke loop`.
> Scope of this document: the **full** KDI-UI-016 item — a single hermetic, repeatable end-to-end smoke test that proves the SvelteKit UI and the kdi CLI read and write the same SQLite database. This is a **spec-writing task**, not an implementation. All behavior contracts are validated against the live CLI/model source.

---

## 1. Business Goal

Give maintainers confidence that the SvelteKit operator UI is not just a separately tested shell, but a working end-to-end path over the same data and operations as the CLI. The smoke test is the final gate for promoting `FF_SVELTEKIT_FRONTEND` from `InDev` to `Active`.

## 2. Problem Statement

The kdi CLI has a large, well-tested surface. The SvelteKit UI is built as a thin layer of server routes and components on top of the same models. Individual unit tests or component tests can pass while the integration fails (wrong JSON shape, stale server state, missing env flag, database path mismatch, or browser/client vs server model drift). A single hermetic loop that starts from `kdi init`, exercises a realistic task lifecycle through both the CLI and the UI, and asserts parity closes that gap.

## 3. Prerequisites (hard blockers)

- **KDI-UI-000 — SvelteKit app shell.** `apps/web/` exists and builds; `FF_SVELTEKIT_FRONTEND` is registered and the server hook redirects to `/disabled` when the flag is off.
- **KDI-UI-001 — server-side data bridge.** SvelteKit server routes can read and write the same SQLite DB that the CLI uses, with isolated `HOME`/`KDI_DB`.
- **KDI-UI-002 — board management UI.** The UI can create and switch boards.
- **KDI-UI-003 — kanban board view.** The UI can list tasks and show status columns.
- **KDI-UI-004 — task create/edit UI.** The UI can create a task with title and body.
- **KDI-UI-005 — task detail panel.** The UI can render a task's result, log, and events.
- **KDI-UI-006 — task lifecycle actions.** The UI can promote, archive, and otherwise transition a task.
- **KDI-UI-007 — dispatch control center.** The UI can trigger `dispatch --once` and read resulting status.
- Existing profile system (`src/profiles.ts`) must support a custom no-op profile that writes `{{result_file}}` and exits 0 without requiring real agent binaries.

KDI-UI-016 adds **only** the smoke test harness and one (or more) test files. It must not modify `src/models/*`, `src/commands/*`, `src/db.ts`, or `src/flags.ts` beyond imports.

## 4. Scope

In scope:
- A hermetic end-to-end test script that runs `init → create board → create task → promote → dispatch once → inspect result/log/events → archive` through both CLI and UI paths.
- A deterministic no-op harness profile used by the smoke test.
- Assertions that data written by the CLI is visible in the UI and vice versa.
- Temp `HOME` and temp `KDI_DB` for isolation.

Out of scope (explicitly):
- New UI screens or components.
- New CLI commands or model functions.
- New feature flags.
- Browser-level visual regression tests.
- Exhaustive coverage of every CLI flag; the loop covers the minimal real path.

## 5. Current vs Desired Behavior

| Aspect | Current | Desired |
|---|---|---|
| UI verification | Manual clicking or isolated unit tests | One command runs the entire loop and asserts CLI/UI parity |
| DB sharing | CLI and UI may be tested against different DB files | Smoke test uses one temp `KDI_DB` for both paths |
| Harness | Real agents require external binaries | Smoke test uses a no-op profile that writes `{{result_file}}` |
| Promotion gate | No automated gate for `FF_SVELTEKIT_FRONTEND` | Passing smoke test is the gate for promoting the UI flag |

## 6. Functional Requirements

### 6.1 Test environment

- **FR-1** The test creates a temporary directory, sets `HOME` to it, and sets `KDI_DB` to a fresh SQLite file inside it.
- **FR-2** The test enables `FF_SVELTEKIT_FRONTEND=true` and `VITE_FF_SVELTEKIT_FRONTEND=true` for the UI server and any browser client.
- **FR-3** The test writes a `smoke` harness profile to `$HOME/.config/kdi/profiles.yaml`:
  ```yaml
  - name: smoke
    command: 'mkdir -p "{{workdir}}" && printf "smoke completed: %s" "{{title}}" > "{{result_file}}"'
    agent: smoke
  ```
  The profile must be valid under `src/profiles.ts` and must not require any external agent binary.
- **FR-4** The test runs `kdi init` in the isolated environment.
- **FR-5** The test builds the CLI binary (`bun run build`) and the SvelteKit app (`bun run build:web`) before starting the loop, or uses dev/preview mode depending on the harness.

### 6.2 CLI path

- **FR-6** Create a board: `kdi boards create smoke --switch --workdir <temp>`.
- **FR-7** Create a task: `kdi create "Smoke task" --body "Smoke body" --assignee smoke`.
- **FR-8** Promote the task to `ready`: `kdi promote 1`.
- **FR-9** Dispatch once: `kdi dispatch --once --max 1`.
- **FR-10** After dispatch, the task is `done` with a result matching `smoke completed: Smoke task`.
- **FR-11** Read worker log, events, and runs via `kdi log 1`, `kdi tail 1`, and `kdi runs 1`.

### 6.3 UI path

- **FR-12** Start the SvelteKit preview server (or dev server) pointing at the same `HOME` and `KDI_DB`.
- **FR-13** The test opens the board view (`/`) and asserts the task created by the CLI is listed in the `done` column with the same title.
- **FR-14** The test opens the task detail view (`/tasks/[id]` or similar route) and asserts the body, status, result, and log/events are rendered.
- **FR-15** The test creates a second task via the UI create form, then uses the CLI (`kdi show 2`) to assert it exists with the same title and body.
- **FR-16** The test promotes the second task via the UI, dispatches once via the UI (or CLI), and asserts it becomes `done`.
- **FR-17** The test archives the second task via the UI and asserts it no longer appears in the active board view but is visible in the archived column/filter.

### 6.4 Parity assertions

- **FR-18** Every mutation performed by the CLI is visible in the UI within the same poll cycle (or after a page refresh).
- **FR-19** Every mutation performed by the UI is visible in the CLI (`kdi show`, `kdi list`) immediately.
- **FR-20** The result written by the smoke harness appears identically in the CLI (`kdi show 1`) and the UI task detail.

### 6.5 Tooling and harness

- **FR-21** The smoke test is implemented as a runnable script under `apps/web/tests/` or a root `scripts/` file that can be invoked by `bun run smoke:web` or similar.
- **FR-22** If the test uses browser automation, it may add `playwright` as a dev dependency in `apps/web/package.json`. If it uses fetch-only testing against SvelteKit server routes, it must not add new dependencies.
- **FR-23** The test runs in a single `bun test` invocation or a standalone Bun script, and exits non-zero on any assertion failure.

## 7. Data Contract

### 7.1 Test inputs

| Input | Value | Notes |
|---|---|---|
| `HOME` | temp dir | Isolated profile/config |
| `KDI_DB` | `$temp/kdi.db` | Shared by CLI and UI |
| `FF_SVELTEKIT_FRONTEND` | `true` | Enables UI |
| `VITE_FF_SVELTEKIT_FRONTEND` | `true` | Browser flag badge |
| Board slug | `smoke` | Created via CLI or UI |
| Task title | `Smoke task` | First CLI-created task |
| Task body | `Smoke body` | |
| Assignee | `smoke` | No-op profile |

### 7.2 Expected outcomes

| Step | CLI state | UI state |
|---|---|---|
| After create | `kdi list` shows task 1 in `todo` | Board view shows task 1 in `todo` |
| After promote | Task 1 in `ready` | Board view shows task 1 in `ready` |
| After dispatch | Task 1 in `done` with result `smoke completed: Smoke task` | Detail panel shows same status and result |
| After archive | Task 1 in `archived` | Task 1 appears in archived filter/column |

## 8. Feature Flags

- `ff_sveltekit_frontend` / `FF_SVELTEKIT_FRONTEND` (browser: `VITE_FF_SVELTEKIT_FRONTEND`), default `false`, status `InDev`. The smoke test enables this flag in the isolated environment.
- Existing CLI/UI flags reused by the path (no new flags): `FF_ENABLE_KANBAN_DISPATCH`, `FF_RESULT_SUMMARY`, `FF_WORKER_LOG_CAPTURE`, `FF_DISPATCH_ONCE`.

## 9. Acceptance Criteria

- **AC-01** The smoke test runs in a fresh temp `HOME` and `KDI_DB` and exits 0.
- **AC-02** `kdi init` succeeds in the temp environment.
- **AC-03** A board created via the CLI is visible in the UI board list.
- **AC-04** A task created via the CLI appears in the UI kanban board view in the correct status column.
- **AC-05** After `kdi dispatch --once --max 1`, the task is `done` and the UI task detail shows the same result.
- **AC-06** The UI can create a task, and the CLI shows the task with the same title and body.
- **AC-07** The UI can promote a task, and `kdi list` shows it in `ready`.
- **AC-08** The UI can archive a task, and `kdi list --status archived` shows it.
- **AC-09** Worker log and events rendered by the UI match `kdi log` and `kdi tail` output.
- **AC-10** The test runs `bun run lint` and `bun run build` (CLI) plus `bun run build:web` and `bun run check:web` before or after the loop and they pass.
- **AC-11** The smoke test does not modify `src/models`, `src/commands`, `src/db.ts`, or `src/flags.ts`.

## 10. Risks and Open Questions

- **Blocked on earlier KDI-UI items.** This smoke test cannot run until KDI-UI-001 through KDI-UI-007 are implemented. Mitigation: keep the spec focused on the loop and the parity assertions; mark blocked prerequisites explicitly.
- **Harness profile drift.** If the result-file contract or profile template variables change, the smoke profile must be updated. Mitigation: validate the profile against `src/profiles.ts` at test start.
- **Real binary availability.** The default `pi`/`opencode` profiles may not be installed in CI. The smoke profile avoids this entirely.
- **Browser vs server-route testing.** A full browser test is slower and may need Playwright. A server-route test is faster but skips client-side rendering. The spec allows either; the implementer should choose the simplest harness that exercises the UI routes.
- **Port collisions.** The SvelteKit preview/dev server needs a free port. Mitigation: let the test pick port 0 or a random high port and read the actual URL from the process output.
- **Database contention.** The CLI and UI server must not hold conflicting locks. SQLite is fine for read-after-write; the test should wait for each server response before asserting.
- **Goal-mode / swarm / triage / LLM features.** These are out of scope for the minimal loop. A future iteration can add a second smoke scenario that exercises them once KDI-UI-011/012 land.

## 11. STATUS.md Update Notes

Add a section under the SvelteKit UI Backlog area:

```markdown
## KDI-UI-016: End-to-end UI Smoke Loop — Spec
- [x] BRD/spec drafted at `specs/sveltekit-ui/KDI-UI-016-end-to-end-ui-smoke-loop.md`
- [ ] Hermetic smoke test uses temp HOME and temp KDI_DB
- [ ] Real path: init → create board → create task → promote → dispatch once → inspect result/log/events → archive
- [ ] CLI-created task is visible in UI board view and detail panel
- [ ] UI-created task is visible in `kdi show` / `kdi list`
- [ ] No new UI screens, CLI commands, or flags; only a test harness and a no-op smoke profile
- [ ] `bun run lint`, CLI build, `bun run build:web`, and `bun run check:web` pass
```

## 12. Spec Location

`specs/sveltekit-ui/KDI-UI-016-end-to-end-ui-smoke-loop.md`

## 13. Worktree Branch Name

`feat/kdi-ui-016-end-to-end-ui-smoke-loop`

(Implementation item; implementer creates a worktree per `AGENTS.md`. Spec authoring for this item was non-editing and ran in the shared checkout.)

## 14. Dependencies / Model Surface This Item Consumes

Validated live in the CLI/model source:

- `init` command / `getDb()` and schema creation.
- `boards create`, `boards switch`, `showBoard`.
- `createTask`, `promoteTask`, `archiveTask`, `showTask`, `listTasks`.
- `dispatch --once` / `tick()`.
- `kdi log`, `kdi tail`, `kdi runs`.
- `profiles.yaml` parsing and profile validation via `src/profiles.ts`.
- `FF_SVELTEKIT_FRONTEND` and `VITE_FF_SVELTEKIT_FRONTEND` gating via `src/flags.ts` and `apps/web/src/hooks.server.ts`.

No new model functions or CLI commands are introduced.
