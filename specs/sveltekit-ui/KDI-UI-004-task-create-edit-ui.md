# Specification: KDI-UI-004 — Task Create/Edit UI

> Parent backlog: `specs/sveltekit-ui-backlog.md` → `KDI-UI-004: Task create/edit UI`.
> Scope of this document: the **full** KDI-UI-004 item — a browser operator UI for creating tasks and editing the fields the current model already supports. This is a **spec-writing task**, not an implementation. All behavior contracts are validated against the live CLI/model source (`src/models/task.ts`, `src/models/dependency.ts`, `src/models/workflowTemplate.ts`, `src/commands/tasks.ts`, `src/profiles.ts`, `src/flags.ts`, `specs/feature-flags.md`).

---

## 1. Business Goal

Give operators a browser UI for creating tasks with the full set of fields that `kdi create` already exposes, and for editing the task body (the only field the current `editTask` model supports). The UI must map every optional field to the same feature flags the CLI uses, so a flag that is off in the CLI is also off in the UI. A task created through the UI must be indistinguishable from one created with `kdi create` when viewed through `kdi show` and the KDI-UI-003 kanban board view.

## 2. Problem Statement

`kdi create` is feature-complete and flag-stable on the CLI, but there is no UI. Task metadata is dense (title, body, assignee, status, schedule, priority, tenant, skills, model, runtime, retries, workspace, session, workflow, goal mode, parent dependencies) and the flag matrix is large. A browser form is needed both to reduce operator error and to make the full create surface discoverable. At the same time, the current model's `editTask` only edits `body`; other "edit-like" changes (assign, status, schedule, priority, etc.) are lifecycle actions owned by KDI-UI-006, not this form. The create/edit UI must therefore not invent unsupported edit fields.

## 3. Prerequisites (hard blockers)

- **KDI-UI-000 — SvelteKit app shell.** `apps/web` SvelteKit app scaffolded; `FF_SVELTEKIT_FRONTEND` registered in `src/flags.ts` (InDev, default `false`) and `VITE_FF_SVELTEKIT_FRONTEND` available to the browser; AGENTS.md amended to permit `apps/web/`; CLI `bun run build` and SvelteKit build/dev work with isolated `KDI_DB`.
- **KDI-UI-001 — server-side data bridge.** SvelteKit server routes/load actions can call existing KDI model code (`src/models/*`) and return UI-shaped JSON; SQLite access stays server-side only. One smoke test can create a temp board/task through the bridge and read it back. (A draft for this bridge exists at `specs/sveltekit-ui/KDI-UI-001-server-data-bridge.md`.)
- **KDI-UI-002 — board management UI.** The board exists and a board detail/list route is available; the task create form needs a board slug context.

KDI-UI-004 adds **only** SvelteKit routes/components and the narrow server loaders/actions its screens need. It must not modify `src/models/*`, `src/commands/*`, `src/db.ts`, or `src/flags.ts` beyond imports. If a needed JSON shape is missing (e.g. a board's workflow template list), the gap is raised against KDI-UI-001, not patched here.

## 4. Scope

In scope:
- A **create-task** route under a board context (`boards/[slug]/tasks/new`) with a form that supports every `kdi create` field listed in the parent backlog.
- An **edit-task** route (`boards/[slug]/tasks/[id]/edit`) that supports editing the task body via the existing `editTask` model.
- Server-side validation that mirrors the CLI (same model calls, same error text, same feature-flag gating).
- Native form controls only: text inputs, textareas, selects, number inputs, datetime-local inputs, and checkboxes.
- Reuse of the existing CLI feature flags per field; no new flags.

Out of scope (explicitly):
- **Title, assignee, status, priority, schedule, tenant, created-by, skills, model, runtime, retries, workspace, session, workflow, goal mode, or parent dependency "editing"** after creation. These are lifecycle actions or not supported by `editTask`; they belong to KDI-UI-006 (task lifecycle actions) or require new model work. The edit form only edits `body`.
- Custom widgets (date pickers, rich text editors, drag-and-drop parent pickers, etc.).
- Triage LLM (`specify`/`decompose`), swarm creation, dispatch, notifications, stats, diagnostics, or task detail/activity views (other KDI-UI items).
- Auth/multi-user, WebSockets/SSE, or file attachments (non-goals per backlog).
- Any change to CLI commands, models, db schema, or flag semantics.

## 5. Current vs Desired Behavior

| Aspect | Current (CLI) | Desired (UI) |
|---|---|---|
| Create task | `kdi create <title> [options]` | Form under `boards/[slug]/tasks/new` with all options |
| Edit task body | `kdi edit <id> --body <text>` | Form under `boards/[slug]/tasks/[id]/edit` |
| Field visibility | `--help` lists options | Fields shown/hidden based on same feature flags |
| Validation | CLI command validates and calls model | Server action validates and calls same model |
| Output | Task ID printed | Redirect to board view / task detail with flash |
| Board view parity | `kdi list` / `kdi show` read the same DB | Created task appears in KDI-UI-003 and `kdi show` |

## 6. Functional Requirements

### 6.1 Create form

- **FR-1** A `boards/[slug]/tasks/new` route provides a form and a `+page.server.ts` action that calls `createTask(input)` with the board ID from `showBoard(slug, false)`. A missing or archived board renders a `404` / `Board "..." not found.` error and does not show the form.
- **FR-2** The form uses a `POST` server action; no client-side mutation of SQLite. The browser never imports `~/models/*` or `bun:sqlite`.
- **FR-3** `title` is required. Empty or whitespace-only values are rejected with the same text the model/CLI produces (`Title is required.`). The form stays mounted with values preserved on error.
- **FR-4** `body` is optional. If provided, it is stored as-is.
- **FR-5** `assignee` is optional. It is a free-text profile name; no separate feature flag is required because the CLI `create --assignee` is not gated by a flag.
- **FR-6** `status` is a `<select>` of all `InitialTaskStatus` values: `triage`, `todo`, `scheduled`, `ready`, `running`, `done`, `blocked`, `review`. The default is `todo`. If `scheduled` is selected, the `scheduled_at` field is required and must be in the future.
- **FR-7** `scheduled_at` is a `datetime-local` input converted to Unix seconds before calling `createTask`. It is shown only when `FF_SCHEDULED_STATUS` is on. With the flag off, a submitted `scheduled_at` is rejected with `"Scheduled status feature is not enabled."`. If `status === "scheduled"` and `scheduled_at` is missing, reject with `"initial status 'scheduled' requires scheduled_at to be set"`.
- **FR-8** `priority` is a number input. It is shown only when `FF_PRIORITY_INTEGER` is on and validated as an integer. With the flag off, a submitted value is rejected with `"Priority integer feature is not enabled."`.
- **FR-9** `tenant` is a text input. It is shown only when `FF_TENANT_NAMESPACE` is on. Empty/whitespace values are rejected with `"Tenant cannot be empty."`.
- **FR-10** `created_by` is a text input. It is shown only when `FF_CREATED_BY` is on. When the flag is off, the create action uses the CLI fallback chain (`KDI_CREATED_BY` → `USER` → `"unknown"`) and does not accept a UI override. With the flag on and an empty value, reject with `"Created-by cannot be empty."`.
- **FR-11** `skills` is a text input accepting comma-separated skill names (e.g. `git,python`). It is shown only when `FF_SKILLS_ARRAY` is on. Each skill is trimmed and validated against the CLI pattern `^[a-zA-Z0-9_-]+$`; invalid names reject with `"Invalid skill name \"...\". ..."`.
- **FR-12** `model_override` is a text input. It is shown only when `FF_MODEL_OVERRIDE` is on. Empty values are rejected with `"Model cannot be empty."`.
- **FR-13** `max_runtime_seconds` is a text input accepting durations like `30m`, `1h`, `2d`, `90s` or raw seconds. It is shown only when `FF_MAX_RUNTIME` is on. The action calls `parseDuration(value)` from `src/models/task.ts`; invalid values surface verbatim.
- **FR-14** `max_retries` is a number input. It is shown only when `FF_MAX_RETRIES` is on. It must be a non-negative integer; invalid values surface with the CLI text.
- **FR-15** `workspace` is a text input for a path. It is shown only when `FF_DEFAULT_WORKDIR` is on. If omitted and the board has `default_workdir`, the action inherits that value (same as the CLI). Empty values are rejected with `"Workspace cannot be empty."`. There is no directory picker; the path is typed.
- **FR-16** `session_id` is a text input. It is shown only when `FF_LIST_FILTERS_SORT` is on. Empty values are rejected with `"Session ID cannot be empty."`.
- **FR-17** `workflow_template_id` is a `<select>` populated from `listWorkflowTemplates(board.id)` (provided by KDI-UI-001). `current_step_key` is a `<select>` populated from the chosen template's `steps`. Both are shown only when `FF_WORKFLOW_TEMPLATES` is on. Selecting a step without a template is rejected with `"--step-key requires --workflow-template-id."`. If a template is selected but no step is chosen, the action uses the first step. The step key is validated against the template with `validateStepKey()`.
- **FR-18** `goal_mode` is a checkbox. When checked, `goal_max_turns` (positive integer) and `goal_judge_profile` (select/text) are required. These fields are shown only when `FF_GOAL_MODE` is on. The judge profile is validated against `getProfile()` from `src/profiles.ts`; unknown profiles reject with `"Unknown judge profile \"...\"."`. `--goal` without `--goal-max-turns` rejects with `"--goal requires --goal-max-turns <n>."`. The `goal_remaining_turns` is initialized by the model to the same value as `goal_max_turns`.
- **FR-19** `parent_ids` are one or more task IDs (text input, comma-separated). They are shown only when `FF_CREATE_PARENT` is on. Each ID must parse to a positive integer, must exist as a non-archived task on the same board, and must not be the same as the new task (self-dependency) or create a cycle. After `createTask` succeeds, the action calls `addDependency(parentId, task.id)` for each parent. Duplicate links are idempotent (the model ignores the UNIQUE constraint error).
- **FR-20** On successful create, the action redirects to the board view route (KDI-UI-003) for the same board, with a flash message naming the new task ID. The new task must appear in `kdi show <id>` and in the board view when read back through the same `KDI_DB`.
- **FR-21** All flag-gated fields are disabled (visible but greyed) when their flag is off, and a server-side rejection is enforced if a value is submitted anyway.
- **FR-22** The form uses native HTML controls only; no custom date picker, no rich-text editor, no searchable multi-select for skills/parents.

### 6.2 Edit form

- **FR-23** A `boards/[slug]/tasks/[id]/edit` route loads the task via `showTask(id)`. If the task is missing or archived, the route renders a 404 / `Task <id> not found.` error.
- **FR-24** The edit form contains only a `body` textarea. The model `editTask(id, body)` is the only supported edit; the form does **not** offer title, assignee, status, priority, schedule, tenant, skills, model, runtime, retries, workspace, session, workflow, goal mode, or parent dependency editing.
- **FR-25** The body is required. Empty or whitespace-only values are rejected with `"Body is required."`. On success, the action redirects to the task detail route (KDI-UI-005) or the board view (KDI-UI-003) and the updated body is visible in `kdi show <id>`.
- **FR-26** The edit form is also gated by `FF_SVELTEKIT_FRONTEND`; the server action rejects edits when the flag is off.

### 6.3 Cross-cutting

- **FR-27** The whole UI renders only when `FF_SVELTEKIT_FRONTEND` is enabled (server-side gate). With it off, the routes are unavailable (404 / "UI disabled").
- **FR-28** Every server action re-checks its relevant feature flags; client-side enable/disable is UX only.
- **FR-29** Errors from model functions surface as inline form errors with the original message; values are preserved.
- **FR-30** KDI-UI-004 adds only SvelteKit routes and components that import existing model functions: `createTask`, `editTask`, `showTask`, `showBoard`, `listWorkflowTemplates`, `getWorkflowTemplate`, `validateStepKey`, `addDependency`, `parseDuration`, `getProfile`, `loadProfiles`. It must not modify `src/models/*`, `src/commands/*`, `src/db.ts`, or `src/flags.ts`.

## 7. Data Contract

### 7.1 Routes

Suggested SvelteKit routes (paths are suggestions; the implementer may restructure as long as the contract holds):

| Route | Purpose |
|---|---|
| `/boards/[slug]/tasks/new` | Create task form + action |
| `/boards/[slug]/tasks/[id]/edit` | Edit task body form + action |

### 7.2 Server load data

- **Create route load** returns at least:
  - `board`: from `showBoard(slug, false)` (404 if missing/archived).
  - `flags`: a map of the per-field flags relevant to this screen, resolved server-side from `src/flags.ts`.
  - `templates`: `WorkflowTemplate[]` from `listWorkflowTemplates(board.id)` (empty array when `FF_WORKFLOW_TEMPLATES` is off).
  - `profiles`: `Profile[]` from `loadProfiles()` (used to populate the goal-mode judge profile select when `FF_GOAL_MODE` is on).

- **Edit route load** returns at least:
  - `board`: from `showBoard(slug, false)`.
  - `task`: from `showTask(id)` (404 if missing/archived).
  - `flags`: master flag only (body editing has no per-field flag).

### 7.3 Form payload to model mapping

The create action converts the form payload into a `CreateTaskInput` object:

| UI field | `CreateTaskInput` key | Notes |
|---|---|---|
| title | `title` | required |
| body | `body` | optional |
| assignee | `assignee` | optional |
| status | `initialStatus` | default `todo`; `triage` maps to `triage: true` mutually exclusive |
| scheduled_at | `scheduled_at` | Unix seconds; required when status=scheduled |
| priority | `priority` | integer |
| tenant | `tenant` | string |
| created_by | `created_by` | string; fallback chain when flag off |
| skills | `skills` | array of strings |
| model_override | `model_override` | string |
| max_runtime | `max_runtime_seconds` | parsed via `parseDuration` |
| max_retries | `max_retries` | non-negative integer |
| workspace | `workspace` | string; inherits board default |
| session | `session_id` | string |
| workflow_template_id | `workflow_template_id` | string |
| step_key | `current_step_key` | string; defaults to first step |
| goal_mode | `goal_mode` | boolean |
| goal_max_turns | `goal_max_turns` | positive integer |
| goal_judge_profile | `goal_judge_profile` | string |
| parent_ids | — | linked after creation via `addDependency` |

The edit action calls `editTask(id, body)`.

## 8. Feature Flags

- `ff_sveltekit_frontend` / `FF_SVELTEKIT_FRONTEND` (browser: `VITE_FF_SVELTEKIT_FRONTEND`), default `false`, status `InDev`. Gates the **whole** UI. Inherited; this item adds no new flag of its own.
- Per-field flags reused from the CLI (no new flags):
  - `FF_SCHEDULED_STATUS` — `scheduled_at` and initial status `scheduled`.
  - `FF_PRIORITY_INTEGER` — `priority` field and integer validation.
  - `FF_TENANT_NAMESPACE` — `tenant` field.
  - `FF_CREATED_BY` — `created_by` override.
  - `FF_SKILLS_ARRAY` — `skills` field.
  - `FF_MODEL_OVERRIDE` — `model_override` field.
  - `FF_MAX_RUNTIME` — `max_runtime_seconds` / `parseDuration`.
  - `FF_MAX_RETRIES` — `max_retries` field.
  - `FF_DEFAULT_WORKDIR` — `workspace` field and board default inheritance.
  - `FF_LIST_FILTERS_SORT` — `session_id` field.
  - `FF_WORKFLOW_TEMPLATES` — `workflow_template_id` + `current_step_key`.
  - `FF_GOAL_MODE` — `goal_mode`, `goal_max_turns`, `goal_judge_profile`.
  - `FF_CREATE_PARENT` — `parent_ids` dependencies.

## 9. Acceptance Criteria

- **AC-01 (create minimal)** With all flags enabled, submitting only a title on `boards/[slug]/tasks/new` creates a task via `createTask` and redirects to the board view; the task is visible in `kdi show <id>` and in the KDI-UI-003 board view.
- **AC-02 (create full)** With all flags enabled, filling every supported field creates a task with the expected values; `kdi show <id>` against the same `KDI_DB` displays the same values (title, body, assignee, status, scheduled_at, priority, tenant, created_by, skills, model_override, max_runtime_seconds, max_retries, workspace, session_id, workflow_template_id, current_step_key, goal_mode, goal_max_turns, goal_judge_profile).
- **AC-03 (scheduled requires time)** Selecting status `scheduled` without a `scheduled_at` rejects with `"initial status 'scheduled' requires scheduled_at to be set"` and keeps the form mounted.
- **AC-04 (scheduled future)** A `scheduled_at` in the past or present rejects with `"Scheduled time must be in the future"`.
- **AC-05 (flag gating)** With `FF_GOAL_MODE=false`, the goal-mode checkbox and fields are disabled and a submitted goal-mode payload is rejected with `"Goal mode feature is not enabled."`. Same pattern for every other per-field flag.
- **AC-06 (skills validation)** Submitting a skill like `git,python` succeeds; submitting `git, bad name!` rejects with the CLI skill-name error.
- **AC-07 (workflow step validation)** Selecting a workflow template and an invalid step key rejects with `"Step \"...\" not found in workflow template \"...\". Valid steps: ..."`.
- **AC-08 (parent validation)** Submitting a parent ID that does not exist, is archived, equals the new task, or would create a cycle rejects with the dependency error (e.g. `"Parent task 99 not found."`, `"Self-dependency is not allowed"`, `"Circular dependency is not allowed"`).
- **AC-09 (board default workspace)** Omitting `workspace` when the board has `default_workdir` and `FF_DEFAULT_WORKDIR=true` creates the task with `workspace` set to the board default.
- **AC-10 (edit body)** `boards/[slug]/tasks/[id]/edit` loads the task and updates only `body`; `kdi show <id>` reflects the new body.
- **AC-11 (edit body required)** Submitting an empty body rejects with `"Body is required."` and preserves the form.
- **AC-12 (edit unsupported fields)** The edit form does not contain inputs for title, assignee, status, priority, schedule, tenant, skills, model, runtime, retries, workspace, session, workflow, goal mode, or parents.
- **AC-13 (missing task)** Editing a missing or archived task ID renders a `Task <id> not found.` error and performs no mutation.
- **AC-14 (master flag)** With `FF_SVELTEKIT_FRONTEND=false`, both create and edit routes are unavailable and no mutation occurs.
- **AC-15 (no source churn)** No file under `src/models`, `src/commands`, `src/db.ts`, or `src/flags.ts` is modified (review-enforced; only imports).
- **AC-16 (build)** `bun run lint`, CLI `bun run build`, and the SvelteKit build pass with isolated `KDI_DB`; existing CLI tests remain green.
- **AC-17 (smoke)** A smoke test using temp `HOME` + temp `KDI_DB` can: create a board → create a task through the form with all supported fields → verify the task in `kdi show` and through the board view bridge → edit the body → verify the update. (Depends on KDI-UI-000/001 for the harness and KDI-UI-003 for the board view assertion.)

## 10. Risks and Open Questions

- **Blocked on KDI-UI-001/002:** this item cannot start until the server bridge and board management screens exist. Mitigation: §3 makes the gate explicit; do not bundle the shell or bridge into this slice.
- **Limited edit scope:** operators may expect to edit title/assignee/status/priority in a task form. The model only supports body edits; the UI must make it clear that those other changes are lifecycle actions (KDI-UI-006). Mitigation: label the edit route clearly as "Edit body" and do not render other fields as editable.
- **KDI-UI-003 dependency for acceptance:** AC-01/AC-02/AC-17 require the board view to render the created task. The forms themselves can be built and unit-tested without KDI-UI-003, but the final acceptance criteria require it.
- **Parent dependency picker:** there is no UI-native picker; operators type parent IDs. Mitigation: keep the input simple and validate server-side; a future slice could add a "select from board" dropdown once KDI-UI-003 is solid.
- **Circular dependency validation:** `addDependency` already rejects cycles and self-loops; the UI relies on that.
- **Goal-mode judge profile:** `getProfile` validates against `~/.config/kdi/profiles.yaml`; the UI must surface the same "Unknown profile" error as the CLI.
- **Datetime timezone:** `datetime-local` inputs are browser-local. The action must convert to Unix seconds the same way the CLI `parseTimestamp` does (or reuse `parseTimestamp` if moved to a shared util; if not, document the chosen conversion and parity check).
- **Workspace default inheritance:** the action must read `board.default_workdir` and pass it as `workspace`, matching the CLI create behavior under `FF_DEFAULT_WORKDIR`.
- **Flag matrix:** thirteen flags touch this form. Mitigation: a single server-side `flags` object is passed to the UI; disabled controls render greyed with a tooltip naming the flag; server rejects any submitted disabled value.

## 11. STATUS.md Update Notes

Add a section under the SvelteKit UI Backlog - Drafted area:

```markdown
## KDI-UI-004: Task Create/Edit UI — Spec
- [x] BRD drafted at `specs/sveltekit-ui/KDI-UI-004-task-create-edit-ui.md`
- [ ] Create form supports title, body, assignee, status, schedule time, priority, tenant, created-by, skills, model override, runtime, retries, workspace, session, workflow template + step key, goal mode, and parent dependencies
- [ ] Edit form supports only `body` (the only field `editTask` currently supports)
- [ ] Every optional field gated by the same CLI feature flag; no new flags
- [ ] Acceptance: created task displays correctly in board view (KDI-UI-003) and `kdi show`
- [ ] `bun run lint`, CLI build, SvelteKit build pass
```

## 12. Spec Location

`specs/sveltekit-ui/KDI-UI-004-task-create-edit-ui.md`

## 13. Worktree Branch Name

`feat/kdi-ui-004-task-create-edit`

(Implementation item; implementer creates a worktree per `AGENTS.md`. Spec authoring for this BRD was non-editing and ran in the shared checkout.)

---

## Appendix A — Model surface this item consumes

Validated live in `src/models/task.ts`:

- `Task { id, board_id, title, body, assignee, status, priority, tenant, workspace_kind, workspace, branch, result, summary, block_reason, schedule_reason, review_reason, scheduled_at, created_by, skills, created_at, updated_at, started_at, archived_at, current_run_id, claim_lock, claim_expires, last_heartbeat_at, max_runtime_seconds, max_retries, consecutive_failures, idempotency_key, model_override, rate_limited_until, session_id, workflow_template_id, current_step_key, swarm_parent_id, goal_mode, goal_max_turns, goal_remaining_turns, goal_judge_profile }`
- `CreateTaskInput` supports: `board_id`, `title`, `body`, `assignee`, `priority`, `workspace_kind`, `workspace`, `branch`, `tenant`, `triage`, `initialStatus`, `idempotency_key`, `scheduled_at`, `max_runtime_seconds`, `max_retries`, `skills`, `created_by`, `model_override`, `session_id`, `workflow_template_id`, `current_step_key`, `swarm_parent_id`, `goal_mode`, `goal_max_turns`, `goal_judge_profile`.
- `createTask(input)` returns `Task` and records a `created` event.
- `editTask(id, body)` updates `body` only and returns `Task`.
- `parseDuration(value)` parses `30m`, `1h`, `2d`, `90s`, or raw seconds.
- `VALID_SORT_KEYS` and `listTasks` are consumed by KDI-UI-003, not this form.

Validated live in `src/models/dependency.ts`:

- `addDependency(parentId, childId)` rejects self-dependencies and circular dependencies; idempotent on duplicate parent→child links.
- `isBlockedByDependencies(taskId)` and `getChildTasks(parentId)` are used by KDI-UI-003/KDI-UI-006, not this form.

Validated live in `src/models/workflowTemplate.ts`:

- `WorkflowTemplate { id, board_id, template_id, name, steps, created_at, updated_at }`
- `listWorkflowTemplates(boardId)`, `getWorkflowTemplate(boardId, templateId)`, `validateStepKey(template, key)`

Validated live in `src/profiles.ts`:

- `loadProfiles()` and `getProfile(name)` for goal-mode judge validation.

## Appendix B — CLI command surface mirrored

Validated live in `src/commands/tasks.ts` (`kdi create`):

- `create <title> --board <slug> --assignee --body --triage --initial-status --at --priority --idempotency-key --max-runtime --max-retries --tenant --skill --parent --model --created-by --workspace --session --workflow-template-id --step-key --goal --goal-max-turns --goal-judge`
- `--max-runtime` gated by `FF_MAX_RUNTIME`
- `--max-retries` gated by `FF_MAX_RETRIES`
- `--tenant` gated by `FF_TENANT_NAMESPACE`
- `--skill` gated by `FF_SKILLS_ARRAY`
- `--parent` gated by `FF_CREATE_PARENT`
- `--model` gated by `FF_MODEL_OVERRIDE`
- `--created-by` gated by `FF_CREATED_BY`
- `--workspace` gated by `FF_DEFAULT_WORKDIR`
- `--session` gated by `FF_LIST_FILTERS_SORT`
- `--workflow-template-id`/`--step-key` gated by `FF_WORKFLOW_TEMPLATES`
- `--goal*` gated by `FF_GOAL_MODE`
- Initial `scheduled` status requires `--at` and `FF_SCHEDULED_STATUS` is the relevant flag for schedule-related features.

Validated live in `src/commands/tasks.ts` (`kdi edit`):

- `edit <task_id> --body <text>` — edits body only; requires non-empty body.
