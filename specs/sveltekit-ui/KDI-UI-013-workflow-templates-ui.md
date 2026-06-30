# Specification: KDI-UI-013 — Workflow Templates UI

> Parent backlog: `specs/sveltekit-ui-backlog.md` → `KDI-UI-013: Workflow templates UI`.
> Scope of this document: the **full** KDI-UI-013 item — a browser-based UI for managing board-scoped workflow templates, creating tasks from them, and advancing/jumping workflow steps with reasons. This is a **spec-writing task**, not an implementation. All behavior contracts are validated against the live CLI/model source (`src/commands/workflows.ts`, `src/commands/tasks.ts`, `src/models/workflowTemplate.ts`, `src/models/task.ts`, `src/flags.ts`).

---

## 1. Business Goal

Give operators a browser-based way to define, inspect, and use workflow templates, mirroring the CLI's `kdi workflows define`, `kdi workflows list`, `kdi create --workflow-template-id`, and `kdi step` commands. The UI must produce the same templates and task mutations as the CLI, with the same validation and feature-flag gating, so operators can build multi-step workflows without dropping to the terminal.

## 2. Problem Statement

Workflow templates are implemented in the CLI (`kdi workflows ...`) but the SvelteKit operator UI has no corresponding surface. Operators who prefer the browser cannot define templates, see a board's templates, create a task from a template, or advance a task through its template steps without shelling out. The backend already exposes `defineWorkflowTemplate`, `listWorkflowTemplates`, `createTask`, `advanceTaskStep`, and `setTaskStep`; the UI only needs server-side loaders/actions and presentation components.

## 3. Prerequisites (hard blockers)

- **KDI-UI-000 — SvelteKit app shell.** `apps/web/` exists, `FF_SVELTEKIT_FRONTEND` is registered, and the server hook redirects to `/disabled` when the flag is off.
- **KDI-UI-001 — server-side data bridge.** SvelteKit server routes/load actions can call existing KDI model code (`src/models/*`) and return UI-shaped JSON. SQLite access stays server-side only.
- **KDI-UI-002 — board management UI (recommended).** The workflow UI is board-scoped; a board switcher/list makes navigation easier. Until KDI-UI-002 lands, the route can operate with a board slug from the URL.
- **BRD-KDI-039 — Workflow Templates.** The CLI/model work is done: `workflow_templates` table, `defineWorkflowTemplate`, `listWorkflowTemplates`, `getWorkflowTemplate`, `validateStepKey`, `advanceTaskStep`, `setTaskStep`, and `FF_WORKFLOW_TEMPLATES` are wired to `kdi workflows define/list`, `kdi create --workflow-template-id`, and `kdi step`.

KDI-UI-013 adds **only** the workflow templates route, the task-from-template action, and the step action. It must not modify `src/models/*`, `src/commands/*`, `src/db.ts`, or `src/flags.ts` beyond imports. If a needed JSON shape is missing, the gap is raised against KDI-UI-001 or BRD-KDI-039, not patched here.

## 4. Decision Options

1. **Board-scoped `/boards/[slug]/workflows` route with inline list and define form.** The route lists templates, shows a define form, and offers a quick "Create task from template" action on each row. A separate step action lives on the task detail page. **Chosen.** Board-scoped URLs match KDI-UI-004; the workflow list is the natural place to manage templates and create tasks from them.
2. **A modal-heavy workflow manager.** Templates and create-from-template are in modals launched from the board view. This adds client complexity without reducing scope. Rejected for v1.
3. **Shell out to the CLI binary from the UI.** Re-parses text and pays spawn cost. Rejected.

## 5. Current vs Desired Behavior

| Aspect | Current (CLI) | Desired (UI) |
|---|---|---|
| List templates | `kdi workflows list --board <slug>` | `/boards/[slug]/workflows` lists templates with id, name, steps |
| Define template | `kdi workflows define <id> --name <name> --steps <json>` | Inline form on `/boards/[slug]/workflows` that creates or replaces a template |
| Create task from template | `kdi create <title> --board <slug> --workflow-template-id <id> [--step-key <key>]` | Quick-create form on each template row: title + optional step key |
| Advance step | `kdi step <task_id>` | "Next step" button on task detail page with optional reason |
| Jump step | `kdi step <task_id> --to <key>` | "Jump to step" select on task detail page with optional reason |
| Show workflow | `kdi show <task_id>` displays template and current step | Task detail panel (KDI-UI-005) shows the same fields |

## 6. Scope

In scope:
- A board-scoped `/boards/[slug]/workflows` route with a list of templates and a define/upsert form.
- A quick-create task form on each template row (title + optional initial step key).
- A SvelteKit server action for stepping a task: advance to next step or jump to a specific step, with an optional reason.
- Server-side validation that mirrors the CLI using the same model functions.
- Native form controls only: text inputs, textarea, and selects.

Out of scope (explicitly):
- Deleting workflow templates (no backend support today).
- Editing a task's workflow template after creation (no backend support; use archive + recreate).
- Visual workflow designer with drag-and-drop nodes. v1 is a list of step keys.
- Browser-side SQLite access.
- WebSockets/SSE real-time updates.
- Auth, sessions, or multi-tenant permissions.
- Any change to CLI commands, models, db schema, or flag semantics.

## 7. Functional Requirements

### 7.1 Route and loader

- **FR-1** A `/boards/[slug]/workflows` route provides a `+page.server.ts` load function that resolves the board via `showBoard(slug, false)`. A missing or archived board renders an inline error and does not show the form.
- **FR-2** The loader returns the board metadata and the list of templates from `listWorkflowTemplates(board.id)`. The response is normalized to camelCase at the route boundary, matching KDI-UI-001.
- **FR-3** The loader returns runtime state: `flags.workflowTemplates` (from `FF_WORKFLOW_TEMPLATES`). When the flag is off, the page renders a disabled message and the define/create-from-template actions are rejected server-side with the same message as the CLI: `"Workflow templates feature is not enabled."`.

### 7.2 Template list

- **FR-4** The `/boards/[slug]/workflows` page renders a list or table of workflow templates. Each row shows: `template_id`, `name`, and the ordered step keys (`steps.join(" → ")`).
- **FR-5** Empty state: when the board has no templates, the page shows a clear empty message and the define form.
- **FR-6** Each row exposes a **Create task from template** action that opens a small form with `title` (required) and `step_key` (optional, defaults to the first step). The action validates the step key against the template and creates the task via `createTask`.
- **FR-7** The define form is also available at the top or bottom of the list. It contains: `template_id` (required), `name` (required), and `steps` (textarea, one step key per line). Submitting calls `defineWorkflowTemplate(board.id, templateId, name, steps)`.
- **FR-8** The define form supports replacing an existing template: if `template_id` matches an existing template, the define action updates `name` and `steps`. The UI shows a confirmation or warning that the existing template will be overwritten.
- **FR-9** Step keys are parsed from the textarea by splitting on newlines, trimming whitespace, and rejecting empty lines. This is a UI-side convenience so operators do not have to type JSON.

### 7.3 Define action validation

- **FR-10** `template_id` must match `^[a-zA-Z0-9_-]+$` and be 255 characters or fewer. Reject with the CLI error: `Invalid template id "...". Use only letters, numbers, underscores, and hyphens.`
- **FR-11** `name` must be non-empty and 255 characters or fewer. Reject with: `Template name cannot be empty.` or `Template name must be 255 characters or fewer.`
- **FR-12** The parsed steps must be a non-empty array with at most 100 items, no empty strings, no keys longer than 255 characters, and no duplicates. Reject with the CLI errors: `Template must have at least one step.`, `Template cannot have more than 100 steps.`, `Step keys cannot be empty.`, `Step key "..." exceeds 255 characters.`, `Duplicate step key "...".`
- **FR-13** On successful define, the page reloads with the updated list and the define form is cleared (or pre-filled for an edit). On failure, the form redisplays with the error message and the entered values preserved.

### 7.4 Create task from template

- **FR-14** The quick-create action on a template row calls `createTask` with `board_id`, `title`, `workflow_template_id`, and `current_step_key`. If no `step_key` is provided, it uses the template's first step. If a `step_key` is provided, it validates it with `validateStepKey(template, key)`.
- **FR-15** The quick-create action rejects with the same errors as the CLI: `Workflow templates feature is not enabled.`, `Workflow template ID cannot be empty.`, `Workflow template "..." not found for board "...".`, `Step key cannot be empty.`, `Step "..." not found in workflow template "...". Valid steps: ...`, `--step-key requires --workflow-template-id.`
- **FR-16** On success, the action redirects to the board view (`/boards/[slug]`) or the task detail page (`/boards/[slug]/tasks/[id]`) so the new task is visible. On failure, the form redisplays with the error and values preserved.
- **FR-17** The quick-create form is gated by `FF_WORKFLOW_TEMPLATES`. When the flag is off, the button is absent and the server action rejects with `"Workflow templates feature is not enabled."`.

### 7.5 Step action

- **FR-18** A SvelteKit form action on the task detail page (or at `/boards/[slug]/tasks/[id]/step`) exposes two operations:
  - **Advance:** call `advanceTaskStep(task.id)` to move to the next step. At the terminal step, the task transitions to `done` and `current_step_key` is cleared.
  - **Jump to step:** call `setTaskStep(task.id, targetKey, reason)` to move to a specific step key in the template.
- **FR-19** The step action requires the task to have a `workflow_template_id` and a matching template. Reject with the CLI errors: `Task <id> has no workflow template.`, `Workflow template "..." not found for task <id>. Define it with 'kdi workflows define'.`
- **FR-20** The jump action validates the target step key with `validateStepKey`. Reject with: `Step "..." not found in workflow template "...". Valid steps: ...`
- **FR-21** If the task's current step key no longer exists in the template (e.g., template was redefined), the advance action rejects with: `Task <id> is on step "..." which no longer exists in template "...".`
- **FR-22** An optional **Reason** textarea is submitted with the step action and recorded on the `stepped` event.
- **FR-23** On success, the action returns the updated task and the UI reflects the new `current_step_key` or `done` status. The action success messages mirror the CLI: `Advanced task <id> to step <key>.`, `Set task <id> to step <key>.`, `Completed task <id> at terminal workflow step.`
- **FR-24** The step action is gated by `FF_WORKFLOW_TEMPLATES`. When the flag is off, the controls are absent and the action rejects with `"Workflow templates feature is not enabled."`.
- **FR-25** The step action only appears on the task detail page when the task has a `workflow_template_id` and is not archived. The action is disabled if the task is `done` or `archived`.

### 7.6 Cross-cutting

- **FR-26** The whole UI renders only when `FF_SVELTEKIT_FRONTEND` is enabled (server-side gate via `hooks.server.ts`). The route does not add a new gate for the master flag.
- **FR-27** Every server action re-checks `FF_WORKFLOW_TEMPLATES`; client-side enable/disable is UX only.
- **FR-28** KDI-UI-013 adds only SvelteKit routes/components and imports existing model functions: `defineWorkflowTemplate`, `listWorkflowTemplates`, `getWorkflowTemplate`, `validateStepKey`, `createTask`, `advanceTaskStep`, `setTaskStep`, `showTask`, `showBoard`, `isEnabled`, and `FF_WORKFLOW_TEMPLATES`. It must not modify `src/models/*`, `src/commands/*`, `src/db.ts`, or `src/flags.ts`.
- **FR-29** No client module imports `~/models/*`, `src/models/*`, or `bun:sqlite`. All model calls happen in `+page.server.ts` or server actions.

## 8. Data Contract

### 8.1 Routes

| Route | Purpose |
|---|---|
| `/boards/[slug]/workflows` | List templates + define form |
| `/boards/[slug]/tasks/[id]` | Task detail panel (KDI-UI-005) hosts the step action |

### 8.2 Server load data

The `/boards/[slug]/workflows` load returns at least:
- `board`: from `showBoard(slug, false)` (404 if missing/archived).
- `templates`: `WorkflowTemplate[]` from `listWorkflowTemplates(board.id)` (empty array when flag is off or no templates).
- `flags`: `{ workflowTemplates: boolean }`.

### 8.3 Form payload to model mapping

**Define template:**
| UI field | Model param | Notes |
|---|---|---|
| `template_id` | `templateId` | required, regex-validated |
| `name` | `name` | required, trimmed |
| `steps` | `steps` | textarea split on newlines, trimmed, validated |

**Create task from template:**
| UI field | `CreateTaskInput` key | Notes |
|---|---|---|
| `title` | `title` | required |
| `step_key` | `current_step_key` | optional, defaults to first template step |
| (hidden) | `workflow_template_id` | from the template row |
| (hidden) | `board_id` | from the board |

**Step action:**
| UI field | Model call | Notes |
|---|---|---|
| `action` | — | `"advance"` or `"jump"` |
| `target_key` | `setTaskStep` | required when `action === "jump"` |
| `reason` | reason param | optional, recorded on `stepped` event |

## 9. Feature Flags

- `ff_sveltekit_frontend` / `FF_SVELTEKIT_FRONTEND` (browser: `VITE_FF_SVELTEKIT_FRONTEND`), default `false`, status `InDev`. Gates the **whole** UI. Inherited; this item adds no new flag of its own.
- `ff_workflow_templates` / `FF_WORKFLOW_TEMPLATES`, default `false`, status `InDev`. Gates all template management, create-from-template, and step actions. Inherited from BRD-KDI-039.
- **Rollback / deactivation:** Set `FF_SVELTEKIT_FRONTEND=false` to hide the entire UI; set `FF_WORKFLOW_TEMPLATES=false` to disable workflow templates while leaving the rest of the UI available. The CLI continues to own all workflow template logic.
- **Deprecation plan:** N/A (additive UI).

## 10. Acceptance Criteria

- **AC-01 (route and loader)** The `/boards/[slug]/workflows` route resolves the board from the URL slug, loads templates via `listWorkflowTemplates(board.id)`, and returns board metadata plus the template list. A missing/archived board renders a 404 error.
- **AC-02 (list)** The workflow list displays `template_id`, `name`, and the ordered step keys for each template on the board.
- **AC-03 (empty state)** When the board has no templates, the page shows an empty message and the define form.
- **AC-04 (define new)** Filling the define form with a new `template_id`, `name`, and steps creates a template via `defineWorkflowTemplate`; the reloaded list shows the new template and `kdi workflows list --board <slug>` returns the same data.
- **AC-05 (define upsert)** Submitting the define form with an existing `template_id` updates the template's `name` and `steps`; the list reflects the change and `kdi workflows list` shows the updated template.
- **AC-06 (define validation)** Submitting an invalid `template_id`, empty `name`, empty steps, duplicate step keys, or step keys longer than 255 characters rejects with the same error messages as `kdi workflows define` and preserves the form values.
- **AC-07 (create from template)** On a template row, entering a title and clicking **Create task** creates a task via `createTask` with `workflow_template_id` set to the template and `current_step_key` set to the first step. `kdi show <id>` displays the same template and step.
- **AC-08 (create with custom step)** Entering a title and a specific `step_key` on a template row creates a task starting at that step; an invalid step key rejects with `Step "..." not found in workflow template "...". Valid steps: ...`
- **AC-09 (advance step)** On the task detail page for a task bound to a template, clicking **Next step** calls `advanceTaskStep` and updates the task's `current_step_key`; the UI shows the new step and a `stepped` event is recorded.
- **AC-10 (terminal step)** Clicking **Next step** when the task is on the last step transitions the task to `done`, clears `current_step_key`, and records `stepped` + `completed` events.
- **AC-11 (jump step)** Selecting a step key and clicking **Jump to step** on the task detail page calls `setTaskStep` with the target key and optional reason; the UI shows the new step and the event records the reason.
- **AC-12 (step validation)** Attempting to jump to a step key not in the template rejects with the CLI error; attempting to advance a task with no workflow template or a missing template rejects with the CLI error.
- **AC-13 (flag gating)** With `FF_WORKFLOW_TEMPLATES=false`, the `/boards/[slug]/workflows` page shows a disabled message, the define/create-from-template actions are absent, and any server action rejects with `"Workflow templates feature is not enabled."`. With `FF_SVELTEKIT_FRONTEND=false`, the route is unavailable and the existing disabled screen is shown.
- **AC-14 (no source churn)** No file under `src/models`, `src/commands`, `src/db.ts`, or `src/flags.ts` is modified (review-enforced; only imports).
- **AC-15 (build)** `bun run lint`, CLI `bun run build`, `bun run check:web`, and `bun run build:web` pass with isolated `KDI_DB`; existing CLI tests remain green.
- **AC-16 (smoke)** A smoke test using temp `HOME` + temp `KDI_DB` can: create a board → define a workflow template through the UI → create a task from the template → advance and jump steps → assert the task state matches `kdi show` and `kdi step` output for the same DB.

## 11. Risks and Open Questions

- **Blocked on BRD-KDI-039.** The UI cannot start until the backend workflow-template commands are implemented. Mitigation: this spec documents the exact model surface to consume.
- **No template deletion.** The backend only supports define/list; the UI cannot delete templates. If deletion is needed later, it is a separate backend/UI item. Mitigation: document this as a non-goal.
- **Step action placement.** KDI-UI-013 defines the step action server contract, but the primary placement is the task detail panel (KDI-UI-005). If KDI-UI-005 is not yet implemented, the action can be exposed as a standalone `/boards/[slug]/tasks/[id]/step` route until the detail panel is ready.
- **Template redefinition and existing tasks.** If a template is redefined and an existing task's `current_step_key` no longer exists, the advance action rejects with the CLI error. The operator must use `kdi step --to` (jump) to move the task to a valid step.
- **Reason length.** The CLI does not cap `--reason` length; the UI should cap the textarea at a reasonable length (e.g., 4 KiB) to avoid abuse, matching lifecycle-action reason limits in KDI-UI-006.

## 12. Dependencies / Model surface this item consumes

Validated live in `src/models/workflowTemplate.ts`:
- `WorkflowTemplate { id, board_id, template_id, name, steps, created_at, updated_at }`
- `defineWorkflowTemplate(boardId, templateId, name, steps)` — upserts a template, returns `WorkflowTemplate`.
- `listWorkflowTemplates(boardId)` — returns hydrated templates ordered by `template_id` ASC.
- `getWorkflowTemplate(boardId, templateId)` — returns template or `null`.
- `validateStepKey(template, key)` — throws if key is not in `template.steps`.
- `advanceTaskStep(taskId, reason?)` — advances to next step or completes at terminal step.
- `setTaskStep(taskId, targetKey, reason?)` — jumps to a specific step.

Validated live in `src/models/task.ts`:
- `Task` interface including `workflow_template_id`, `current_step_key`, `status`, `board_id`.
- `createTask(input)` — returns `Task`; input includes `workflow_template_id` and `current_step_key`.
- `showTask(id)` — returns `Task` or `null`.

Validated live in `src/models/board.ts`:
- `showBoard(slug, includeArchived)` — returns board metadata or `null`.

Validated live in `src/flags.ts`:
- `isEnabled(flag)` and `FF_WORKFLOW_TEMPLATES`.

No new model functions, SQL, or flags are introduced by this item.

## 13. Verification Notes

Implementation should prove:
- A smoke test with temp `HOME` + temp `KDI_DB` (same pattern as `kdi-new-feature-loop` and `AGENTS.md` worktree isolation) creates a board via the CLI, then:
  - Loads `/boards/[slug]/workflows`, defines a template, and asserts the list matches `kdi workflows list --json`.
  - Creates a task from the template via the UI and asserts `kdi show <id>` shows the expected `workflow_template_id` and `current_step_key`.
  - Advances the task through all steps via the UI and asserts the final `done` state matches `kdi step` behavior.
  - Jumps the task to an earlier step via the UI and asserts the event reason is recorded.
- A grep/build check that no client module imports `~/models/*`, `src/models/*`, or `bun:sqlite`.
- Run `bun run lint`, CLI `bun run build`, `bun run check:web`, and `bun run build:web` in the smoke environment.

## 14. Spec Location

`specs/sveltekit-ui/KDI-UI-013-workflow-templates-ui.md`

## 15. Worktree Branch Name

`feat/kdi-ui-013-workflow-templates-ui`

(Implementation item; implementer creates a worktree per `AGENTS.md`. Spec authoring for this BRD was non-editing and ran in the shared checkout.)

## 16. STATUS.md Update Notes

Add a section under the SvelteKit UI Backlog area:

```markdown
## KDI-UI-013: Workflow Templates UI — Spec
- [x] BRD drafted at `specs/sveltekit-ui/KDI-UI-013-workflow-templates-ui.md`
- [ ] `/boards/[slug]/workflows` route lists templates and provides a define/upsert form
- [ ] Quick-create action on each template row creates a task via `createTask` with the template and an optional step key
- [ ] Step action on the task detail page advances or jumps workflow steps with an optional reason
- [ ] Server-side validation mirrors the CLI; gated by `FF_WORKFLOW_TEMPLATES` and `FF_SVELTEKIT_FRONTEND`
- [ ] UI smoke with temp HOME/KDI_DB defines templates, creates tasks from templates, and steps tasks; matches `kdi workflows list`/`kdi show`/`kdi step`
- [ ] `bun run lint`, CLI build, `bun run check:web`, and `bun run build:web` pass with isolated `KDI_DB`
```
