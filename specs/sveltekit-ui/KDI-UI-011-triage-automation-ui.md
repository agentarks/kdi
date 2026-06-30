# Specification: KDI-UI-011 — Triage Automation UI

> Parent backlog: `specs/sveltekit-ui-backlog.md` → `KDI-UI-011: Triage automation UI`.
> Scope of this document: the **full** KDI-UI-011 item — a browser-based workbench for running LLM-powered triage automation (`specify` and `decompose`) on one or many triage tasks. This is a **spec-writing task**, not an implementation. All behavior contracts are validated against the live CLI/model source (`src/commands/tasks.ts`, `src/models/task.ts`, `src/llm.ts`, `src/flags.ts`).

---

## 1. Business Goal

Give operators a browser-based triage workbench where they can turn vague triage cards into actionable work. The UI exposes `specify` (promote to `todo` with an LLM-generated body, or manual promotion) and `decompose` (fan a triage task into child tasks) on single tasks, all tasks, or tenant-filtered subsets. It must surface LLM configuration problems, invalid LLM responses, and per-task outcomes as blocking feedback, matching the semantics of `kdi specify` and `kdi decompose`.

---

## 2. Problem Statement

Triage automation is implemented in the CLI (`kdi specify`, `kdi decompose`) but the SvelteKit UI has no equivalent surface. Operators who prefer the browser must either switch to the terminal or miss the feature entirely. The backend already exposes the model functions and LLM client; the UI only needs a server-side wrapper and a presentation layer.

This document specifies the contract KDI-UI-011 must meet once the prerequisites land, so implementation can proceed without re-deriving the CLI/model semantics and reviewers can verify acceptance against a single source of truth.

---

## 3. Prerequisites (hard blockers)

- **KDI-UI-000 — SvelteKit app shell.** `apps/web/` exists, `FF_SVELTEKIT_FRONTEND` is registered, and the server hook redirects to `/disabled` when the flag is off.
- **KDI-UI-001 — server-side data bridge.** SvelteKit server routes/load actions can call existing KDI model code (`src/models/*`) and return UI-shaped JSON. SQLite access stays server-side only.
- **KDI-UI-003 — Kanban board view (recommended).** The triage workbench is a standalone route, but it naturally links from the board view's `triage` column and shares the board-resolution chain. Until KDI-UI-003 lands, the route can operate with a `?board=<slug>` query parameter.
- **BRD-KDI-040 — Triage Automation.** The CLI/model work is done: `specifyTaskWithLlm`, `specifyTask`, `decomposeTask`, `callTriageLlm`, `buildSpecifyPrompt`, `buildDecomposePrompt`, and `FF_TRIAGE_AUTOMATION` exist and are wired to `kdi specify` / `kdi decompose`.

KDI-UI-011 adds **only** the `/triage` route, its server loader, two server actions, and presentation components. It must not modify `src/models/*`, `src/commands/*`, `src/llm.ts`, `src/db.ts`, or `src/flags.ts` beyond imports. If a needed JSON shape is missing, the gap is raised against KDI-UI-001 or BRD-KDI-040, not patched here.

---

## 4. Decision Options

1. **Standalone `/triage` route with a simple task list.** The route loads triage tasks, offers per-row and global actions, and refreshes after mutations. **Chosen.** Minimal dependency on KDI-UI-003; clear scope; easy to link from the board view later.
2. **Inline triage automation inside the Kanban board view.** Add `Specify` and `Decompose` buttons to each triage card in the `triage` column. This conflates KDI-UI-011 with KDI-UI-003/006 and makes it harder to show sweep controls and LLM feedback. Rejected as the primary path; individual card actions can be added later as a shortcut.
3. **Shell out to the CLI binary from the UI.** Use `bun run src/index.ts specify ...` from a server action. This avoids importing models but re-parses text, pays spawn cost, and duplicates CLI argument construction. Rejected.

---

## 5. Current vs Desired Behavior

| Aspect | Current (CLI) | Desired (UI) |
|---|---|---|
| Triage list | `kdi list --status triage` prints a flat list | `/triage` renders a list/table of triage tasks with title, body, assignee, tenant, age |
| Specify one task | `kdi specify <id>` | Per-row "Specify" button; calls `specifyTaskWithLlm(id)` |
| Specify manually | `kdi specify <id> --skip-llm` | Per-row "Specify manually" button; calls `specifyTask(id)` |
| Specify all manually | `kdi specify --all --skip-llm` | "Specify all manually" button; sweeps every triage task without LLM |
| Specify tenant sweep | `kdi specify --all --tenant <name>` | Tenant filter + "Specify all in tenant" button (LLM) |
| Specify tenant manually | `kdi specify --all --tenant <name> --skip-llm` | Tenant filter + "Specify all in tenant manually" button |
| Decompose one task | `kdi decompose <id>` | Per-row "Decompose" button; calls LLM then `decomposeTask(id, ...)` |
| Decompose all | `kdi decompose --all` | "Decompose all" button; sweeps every triage task on the board |
| Decompose tenant sweep | `kdi decompose --all --tenant <name>` | Tenant filter + "Decompose all in tenant" button |
| LLM errors | Printed to stderr; task blocked with `block_reason` | Shown inline next to the affected task; block reason visible |
| Configuration errors | CLI exits before mutating | Global banner or action error; no mutation attempted |
| Progress | Synchronous text output | Row-level spinner/disabled state during LLM calls; global progress for sweeps |

---

## 6. Functional Requirements

### 6.1 Route and loader

- **FR-1** A `/triage` route provides a `+page.server.ts` load function that reads `?board=<slug>` from the URL, resolves the board via the same chain as the CLI (`--board` → `KDI_BOARD` → current board file → `"default"`), and returns the board metadata plus the list of triage tasks. A missing or archived board renders an inline error; the app shell is still rendered.
- **FR-2** The loader calls `listTasks({ board_id, status: "triage", tenant })`, where `tenant` is optional and comes from the query string `?tenant=<name>`. It returns tasks sorted by `created-desc` (the default `kdi list` order). The response is normalized to camelCase at the route boundary, matching KDI-UI-001.
- **FR-3** The loader also returns the runtime state needed for the UI: `FF_TRIAGE_AUTOMATION` enabled/disabled, whether `KDI_TRIAGE_LLM_API_KEY` is configured, and the active tenant filter from the URL.
- **FR-4** All response data is JSON with a documented shape. The client component receives `{ board, tasks, flags: { triageAutomation: boolean, apiKeyConfigured: boolean }, filters: { tenant?: string } }`.

### 6.2 Triage task list

- **FR-5** The `/triage` page renders a list or table of tasks in `triage` status. Each row shows: `id`, `title`, `body` (truncated or collapsed), `assignee`, `tenant`, `age` (relative time from `created_at`), and `created_by`.
- **FR-6** Rows are keyed by `task.id`. The list is read-only; no inline editing is permitted in this item.
- **FR-7** Empty state: when the board has no triage tasks, the page shows a clear empty message and a link back to the board view (or to the future task-create route, KDI-UI-004).
- **FR-8** Each row exposes action buttons: **Specify**, **Specify manually**, and **Decompose**. When `FF_TRIAGE_AUTOMATION` is disabled, the LLM-powered buttons are absent; only **Specify manually** is shown (because manual `specifyTask` is ungated).

### 6.3 Specify action

- **FR-9** A **Specify** button on a row calls a server action that invokes `await specifyTaskWithLlm(task.id)`. On success, the task is promoted to `todo` and disappears from the triage list. A success message names the updated task ID and title.
- **FR-10** A **Specify manually** button calls `specifyTask(task.id)` (no LLM). This path requires a non-empty `body`; if the model throws, the error is shown as blocking feedback for that row. On success, the task disappears from the list.
- **FR-11** A **Specify all** toolbar button calls `listTasks({ board_id, status: "triage" })` and then `specifyTaskWithLlm(task.id)` for each task in the returned list. Each task is processed sequentially. The UI shows per-task success/failure and a final summary (`Specified N/M tasks`).
- **FR-11b** A **Specify all manually** toolbar button calls `listTasks({ board_id, status: "triage" })` and then `specifyTask(task.id)` for each task. It is available even when `FF_TRIAGE_AUTOMATION=false`. It requires each task to have a non-empty body; empty-body tasks are reported as failures and remain in `triage`.
- **FR-12** When `FF_TRIAGE_AUTOMATION=false`, the LLM buttons and **Specify all** are absent, but **Specify all manually** remains available. The server action rejects any LLM-powered request with the same message the CLI uses: `"Triage automation feature is not enabled."`.

### 6.4 Decompose action

- **FR-13** A **Decompose** button on a row calls a server action that mirrors the CLI command: it calls `await callTriageLlm(buildDecomposePrompt(task))`, validates the response, and then calls `decomposeTask(task.id, data)`. On success, the parent is archived and disappears from the triage list; a success message names the created child IDs and count.
- **FR-14** If the LLM call fails or returns invalid JSON, the server action throws, the task remains in `triage`, and the UI shows the block reason from the model (e.g., `"LLM decomposition failed: missing body in response"`). No child tasks are created.
- **FR-15** A **Decompose all** toolbar button calls `listTasks({ board_id, status: "triage" })`, then for each task calls `callTriageLlm(buildDecomposePrompt(task))` and `decomposeTask(task.id, data)`. The UI shows per-task success/failure and a final summary (`Decomposed N/M tasks`).
- **FR-16** When `FF_TRIAGE_AUTOMATION=false`, the **Decompose** buttons are absent and the server action rejects with `"Triage automation feature is not enabled."`.

### 6.5 Sweep operations and tenant filter

- **FR-17** A tenant filter input (free text or dropdown) lets the operator restrict the loaded list and the sweep actions. When a tenant is selected, the URL includes `?tenant=<name>` and the loader calls `listTasks({ board_id, status: "triage", tenant })`.
- **FR-18** **Specify all in tenant**, **Specify all in tenant manually**, **Decompose all in tenant**, and **Decompose all in tenant manually** buttons appear only when a tenant filter is active. They iterate over the tenant-filtered triage list and process each task with the same semantics as **Specify all** / **Specify all manually** / **Decompose all**. The manual variants require each task to have a non-empty body.
- **FR-19** The tenant filter control is shown only when `FF_TENANT_NAMESPACE` is enabled. For triage automation, the server-side tenant parameter for specify/decompose sweeps is also accepted only when `FF_TRIAGE_AUTOMATION` is enabled; when `FF_TRIAGE_AUTOMATION=false` but `FF_TENANT_NAMESPACE=true`, the UI still allows tenant-filtered viewing but rejects tenant-filtered sweeps (matching the CLI error for `--tenant` on `kdi specify`).
- **FR-20** Sweep actions are non-atomic across tasks: a failure on one task does not abort the rest. The UI collects all results and presents them together.

### 6.6 LLM configuration status

- **FR-21** Before any LLM action is attempted, the UI checks whether `KDI_TRIAGE_LLM_API_KEY` is configured. If not, a global banner or disabled action state explains: `"Triage LLM API key is not configured (KDI_TRIAGE_LLM_API_KEY)."` No mutation is attempted.
- **FR-22** The configuration check is server-side, using `Bun.env.KDI_TRIAGE_LLM_API_KEY` in the server action. The value is never exposed to the browser.

### 6.7 Feedback, progress, and error display

- **FR-23** Each action button has a disabled/loading state while its server action is in flight. During a sweep, individual rows are marked as in-progress and the sweep button is disabled.
- **FR-24** Success feedback is concise: task ID, new title, and resulting status for specifies; parent ID and child count for decomposes.
- **FR-25** Error feedback is shown inline for single-task actions and in a summary panel for sweeps. The message is the human-readable error from the model/CLI (e.g., `"Task 42 is not in triage status."`, `"LLM specify failed: missing body in response"`, `"LLM decomposition failed: self-dependency at index 1"`).
- **FR-26** For blocked tasks, the row continues to display the `block_reason` so the operator can see why automation failed. The operator can then edit the task body (KDI-UI-004) or retry.
- **FR-27** Invalid LLM responses are surfaced as blocking feedback by reading the task's `block_reason` after the model call fails, not by guessing the error from the raw response.

### 6.8 Polling / refresh

- **FR-28** After a successful or failed single action, the server action returns the updated task list (or the subset of changed tasks) so the UI can re-render without a full page reload. Alternatively, the UI can re-run the `load` function.
- **FR-29** A manual refresh button re-runs the loader. Optional 5-second polling is acceptable but not required. No SSE/WebSocket (non-goal for v1).

### 6.9 Cross-cutting

- **FR-30** The whole UI renders only when `FF_SVELTEKIT_FRONTEND` is enabled (server-side gate via `hooks.server.ts`). The `/triage` route itself does not add a new gate.
- **FR-31** KDI-UI-011 adds only SvelteKit components, the `/triage` page loader, and two server actions. It imports existing model/LLM functions: `listTasks`, `showBoard`, `readCurrentBoard`/`resolveBoard`, `specifyTaskWithLlm`, `specifyTask`, `decomposeTask`, `callTriageLlm`, `buildDecomposePrompt`, `isEnabled`, and `FF_TRIAGE_AUTOMATION`. It must not modify `src/models/*`, `src/commands/*`, `src/llm.ts`, `src/db.ts`, or `src/flags.ts`.

---

## 7. Scope

In scope:
- The `/triage` route as a triage automation workbench.
- Server-side loader that resolves the board and fetches triage tasks.
- Two server actions: `specifyTaskAction` and `decomposeTaskAction`.
- Triage task list with title, body, assignee, tenant, age, and `created_by`.
- Per-row actions: Specify, Specify manually, Decompose.
- Global actions: Specify all, Decompose all, plus tenant-filtered variants.
- Tenant filter input and URL-based filtering.
- LLM configuration status, progress, and success/error feedback.
- Manual refresh; optional 5-second polling.

Out of scope (explicitly):
- SvelteKit scaffolding / `apps/web` / `FF_SVELTEKIT_FRONTEND` registration (KDI-UI-000).
- General server-side data bridge framework (KDI-UI-001); only the narrow `/triage` loader and actions.
- Kanban board view (KDI-UI-003); the `/triage` route can link to it but does not implement it.
- Task create/edit forms (KDI-UI-004).
- Task detail panel (KDI-UI-005); the triage list can link to `/tasks/[id]` but does not render it.
- General task lifecycle actions such as promote, block, assign, complete (KDI-UI-006).
- Inline editing of triage task fields in the list.
- Multi-turn LLM refinement or chat with the task database.
- WebSockets/SSE or real-time push.
- Any change to CLI commands, models, LLM client, db schema, or flag semantics.

---

## 8. Acceptance Criteria

- **AC-01 (route and loader)** The `/triage` route resolves the board from `?board=<slug>` → current board → `"default"`, loads triage tasks via `listTasks({ board_id, status: "triage" })`, and returns board metadata plus the task list. A missing board renders an inline error.
- **AC-02 (list)** The triage list displays `id`, `title`, `body` (truncated), `assignee`, `tenant`, `age`, and `created_by` for each triage task.
- **AC-03 (empty state)** When no triage tasks exist, the page shows an empty message and a link to the board view.
- **AC-04 (specify one)** With `FF_TRIAGE_AUTOMATION=true` and `KDI_TRIAGE_LLM_API_KEY` set, clicking **Specify** on a triage task calls `specifyTaskWithLlm(task.id)`, promotes the task to `todo`, and removes it from the list. A `specified` event with `{ llm: true }` is recorded.
- **AC-05 (specify manually)** Clicking **Specify manually** calls `specifyTask(task.id)`. If the body is empty, an error is shown and the task remains in `triage`. If the body is non-empty, the task is promoted to `todo` and removed from the list.
- **AC-06 (specify error)** With `FF_TRIAGE_AUTOMATION=true`, if the LLM response is missing `body`, the task is blocked with a reason beginning `"LLM specify failed: ..."`, the row shows that reason, and the task stays in the list.
- **AC-07 (specify all)** **Specify all** processes every triage task on the board, showing per-row progress and a final summary of successes and failures. Failed tasks remain in the list with their block reasons.
- **AC-08 (tenant list)** Selecting a tenant in the filter updates the URL to `?tenant=<name>` and reloads the list with only triage tasks whose `tenant` matches. The tenant filter control is absent when `FF_TENANT_NAMESPACE=false`.
- **AC-09 (tenant specify sweep)** With a tenant filter active, **Specify all in tenant** processes only the displayed tenant-filtered tasks.
- **AC-10 (decompose one)** With `FF_TRIAGE_AUTOMATION=true` and `KDI_TRIAGE_LLM_API_KEY` set, clicking **Decompose** on a triage task calls `callTriageLlm(buildDecomposePrompt(task))` and then `decomposeTask(task.id, data)`. The parent is archived, child tasks are created in `todo`, and a `decomposed` event is recorded with `{ child_ids, child_count }`. The parent disappears from the triage list.
- **AC-11 (decompose validation)** If the LLM returns invalid child indices, a self-dependency, or a cycle, the parent is blocked with a reason beginning `"LLM decomposition failed: ..."`, no children are created, and the parent remains in the list showing the reason.
- **AC-12 (decompose all)** **Decompose all** processes every triage task on the board, showing per-row progress and a final summary. Failed tasks remain in the list with block reasons.
- **AC-13 (tenant decompose sweep)** With a tenant filter active, **Decompose all in tenant** processes only the displayed tenant-filtered tasks.
- **AC-14 (flag gating)** With `FF_TRIAGE_AUTOMATION=false`, the LLM buttons, **Decompose**, **Specify all**, and **Specify all in tenant** are absent. Any attempt to call the LLM server action returns `"Triage automation feature is not enabled."` Manual **Specify manually**, **Specify all manually**, and **Specify all in tenant manually** remain available, but tenant-filtered sweeps are rejected if the server enforces `FF_TRIAGE_AUTOMATION` for `--tenant` (matching the CLI).
- **AC-15 (missing API key)** With `FF_TRIAGE_AUTOMATION=true` but `KDI_TRIAGE_LLM_API_KEY` absent, LLM actions are disabled or show a clear configuration error and do not mutate state.
- **AC-16 (server-only)** No client module imports `~/models/*`, `src/llm.ts`, or `bun:sqlite`. All model/LLM calls happen in `+page.server.ts` or server actions.
- **AC-17 (no code churn)** No file under `src/models`, `src/commands`, `src/llm.ts`, `src/db.ts`, or `src/flags.ts` is modified (review-enforced; only imports).
- **AC-18 (UI smoke)** A smoke test using temp `HOME` + temp `KDI_DB` creates a board with several triage tasks (some with bodies, some without), enables `FF_TRIAGE_AUTOMATION`, mocks `callTriageLlm` to return valid specify/decompose responses, and then:
  - Loads `/triage` and asserts the list matches `kdi list --status triage`.
  - Clicks **Specify** on one task and asserts it moves to `todo` (via `kdi show`).
  - Clicks **Specify manually** on a task with a body and asserts it moves to `todo`.
  - Clicks **Decompose** on one task and asserts the parent is archived and the expected children appear in `todo`.
  - Clicks **Specify all** and asserts all remaining triage tasks are promoted.
- **AC-19 (manual specify sweep)** **Specify all manually** processes every triage task on the board using `specifyTask`, showing per-row progress and a final summary. Tasks with empty bodies remain in `triage` with their error shown.
- **AC-20 (builds)** `bun run lint`, CLI `bun run build`, and the SvelteKit build all pass with isolated `KDI_DB`.

---

## 9. Risks / Open Questions / Gaps

- **Blocked on BRD-KDI-040.** The UI cannot start until the LLM-powered backend is implemented. Mitigation: this spec documents the exact model/LLM surface to consume.
- **LLM cost and latency.** Sweeps over many triage tasks issue sequential LLM calls. The UI should show progress; cancellation is not required for v1. A future enhancement could add per-task confirmation or batching.
- **Decompose failure leaves parent in triage.** The model blocks the parent on validation/LLM errors. The UI must show the `block_reason` clearly; the operator can retry or manually edit the task.
- **Tenant filter with `FF_TENANT_NAMESPACE=false`.** The server must reject tenant-filtered requests; the UI should hide the tenant control. If the flag is off but a `?tenant=` query is present, the loader ignores it or rejects it with the same error as the CLI.
- **No distinct tenant dropdown data.** The UI provides a free-text tenant input because no model helper returns distinct tenant values per board. A dropdown can be derived from the current triage task list if needed. This is a **gap** noted in §6.5 but does not add new SQL.
- **Board switcher dependency.** Until KDI-UI-002 lands, the operator must use `?board=<slug>` or set the current board via `kdi boards switch`. This is documented as a UI dependency, not a gap in this item.
- **Concurrency.** The UI does not need to coordinate with a running dispatcher; `specify` and `decompose` are operator-initiated. The model functions handle the CAS-style transitions.
- **Decompose response preview.** A preview of the planned child graph before creating tasks is a nice-to-have; v1 can proceed without it because the model rejects invalid graphs and blocks the parent.

---

## 10. Feature Flags

- `ff_sveltekit_frontend` / `FF_SVELTEKIT_FRONTEND` (browser: `VITE_FF_SVELTEKIT_FRONTEND`), default `false`, status `InDev`. Gates the **whole** UI. Inherited from KDI-UI-000; this item adds no new flag of its own.
- `ff_triage_automation` / `FF_TRIAGE_AUTOMATION`, default `false`, status `InDev`. Gates `kdi decompose` and the LLM path of `kdi specify`. The UI must mirror this gating exactly.
- `ff_tenant_namespace` / `FF_TENANT_NAMESPACE`, default `true` (Active). Gates the tenant filter control and server-side tenant filtering.
- **Rollback / deactivation:** Set `FF_SVELTEKIT_FRONTEND=false` to hide the entire UI; set `FF_TRIAGE_AUTOMATION=false` to disable LLM-powered actions while leaving manual `specifyTask` available. The CLI continues to own all triage automation logic.
- **Deprecation plan:** N/A (additive UI).

---

## 11. Dependencies / Model surface this item consumes

Validated live in `src/models/task.ts`, `src/models/board.ts`, `src/llm.ts`, and `src/flags.ts`:

- `Task` interface: fields needed for the list (`id`, `title`, `body`, `assignee`, `tenant`, `created_by`, `created_at`, `updated_at`, `status`).
- `listTasks(filter: ListTasksFilter, sort?: string): Task[]` — returns triage tasks; accepts `board_id`, `status: "triage"`, and optional `tenant`.
- `specifyTask(id: number): Task` — manual promotion from `triage` to `todo`; requires non-empty body.
- `specifyTaskWithLlm(id: number, options?: { skipLlm?: boolean }): Promise<Task>` — LLM-aware promotion; throws on LLM/config/validation errors and may block the task.
- `decomposeTask(id: number, decomposition: DecompositionInput): Task[]` — creates child tasks, dependencies, archives the parent, emits `decomposed`. Requires a validated decomposition.
- `callTriageLlm(prompt: LlmPrompt): Promise<LlmResponse>` — makes the LLM call; the UI server action must call it for `decompose` because `decomposeTask` does not call the LLM.
- `buildDecomposePrompt(task: Task): LlmPrompt & { type: "decompose" }` — builds the prompt for `decompose` server actions.
- `showBoard(slug, false): BoardWithTaskCounts | null` — resolves board metadata for the loader.
- `readCurrentBoard(): string | null` or `resolveBoard(...)` — resolves current board slug for the loader fallback.
- `isEnabled(flag)` and `FF_TRIAGE_AUTOMATION` from `src/flags.ts` — gates LLM actions.
- `Bun.env.KDI_TRIAGE_LLM_API_KEY` — configuration check before any LLM mutation.

No new model functions, LLM prompts, or SQL are introduced by this item. If a distinct-tenant dropdown is required, the gap is filed against KDI-UI-001 or BRD-KDI-040, not implemented here.

---

## 12. Verification Notes

Implementation should prove:
- A smoke test with temp `HOME` + temp `KDI_DB` (same pattern as `kdi-new-feature-loop` and `AGENTS.md` worktree isolation) creates a board and several triage tasks via the CLI or bridge, then:
  - Loads `/triage` and asserts the rendered list matches `kdi list --status triage`.
  - Mocks `callTriageLlm` (or uses a test double) to return valid specify/decompose responses.
  - Runs **Specify**, **Specify manually**, **Decompose**, and **Specify all** actions and asserts the resulting task states via `kdi show`.
  - Verifies that invalid LLM responses leave the parent in `triage` with a `block_reason` shown in the UI.
- A grep/build check that no client module imports `~/models/*`, `src/llm.ts`, or `bun:sqlite`.
- Run `bun run lint`, CLI `bun run build`, and the SvelteKit build in the smoke environment.

---

## 13. Spec Location

`specs/sveltekit-ui/KDI-UI-011-triage-automation-ui.md`

---

## 14. Worktree Branch Name

`feat/kdi-ui-011-triage-automation-ui`

(Implementation item; implementer creates a worktree per `AGENTS.md`. Spec authoring for this item was non-editing and ran in the shared checkout.)

---

## 15. STATUS.md Update Notes

Add a section under the SvelteKit UI Backlog area:

```markdown
## KDI-UI-011: Triage Automation UI — Spec
- [ ] BRD drafted at `specs/sveltekit-ui/KDI-UI-011-triage-automation-ui.md`
- [ ] `/triage` route lists triage tasks with Specify, Specify manually, and Decompose actions
- [ ] Single-task and sweep actions for `specify` and `decompose`, including tenant-filtered variants
- [ ] LLM configuration, progress, and blocking feedback on LLM/validation errors
- [ ] Server actions call existing `specifyTaskWithLlm`, `specifyTask`, `decomposeTask`, and `callTriageLlm` directly; no new CLI/model/LLM code
- [ ] UI smoke with temp HOME/KDI_DB asserts list matches `kdi list --status triage` and actions update task states
- [ ] `bun run lint`, CLI build, SvelteKit build pass with isolated `KDI_DB`
```
