# BRD-KDI-039: Workflow Templates

-------------------------------------------------------------------------------
Business Goal
-------------------------------------------------------------------------------
Give operators a lightweight way to model multi-step workflows on a Kanban
board. A workflow template defines an ordered sequence of step keys; tasks
bound to a template advance through those steps rather than being moved
manually through statuses. This provides a v2 routing layer on top of the
existing task lifecycle and brings KDI closer to parity with Hermes Kanban's
`workflow_template_id` + `current_step_key` behavior.

-------------------------------------------------------------------------------
User Stories
-------------------------------------------------------------------------------
1. As an operator, I can define a workflow template with an ordered list of
   step keys so that related tasks follow the same path.
2. As an operator, I can create a task bound to a workflow template so that
   it starts at the template's first step.
3. As an operator, I can advance a task to the next step in its workflow,
   or jump to a specific step, so that routing is explicit and auditable.
4. As an operator, I can list defined workflow templates for a board.
5. As an operator, I can see a task's current template and step in `kdi show`.

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------
- Workflow templates are scoped to a board. Each board can have zero or more
  named templates identified by a stable template id.
- A template has:
  - `id` — board-unique identifier (alphanumeric, underscore, hyphen).
  - `name` — human-readable display name.
  - `steps` — ordered array of non-empty step-key strings. Duplicate step keys
    within the same template are rejected.
- `kdi workflows define <id> --name <name> --steps <json>` creates or replaces
  a template for the resolved board. `--steps` accepts a JSON array of strings.
- `kdi workflows list [--board <slug>]` prints all templates for the resolved
  board.
- `kdi create <title> --workflow-template-id <id>` creates a task bound to the
  template and sets `current_step_key` to the template's first step. This
  option is gated by `FF_WORKFLOW_TEMPLATES`.
- `kdi create <title> --workflow-template-id <id> --step-key <key>` creates a
  task starting at a specific step. The step key must exist in the template.
- `kdi step <task_id>` advances the task to the next step in its template.
  At the terminal step, advancing transitions the task to `done` and clears
  `current_step_key`.
- `kdi step <task_id> --to <key>` jumps the task to an arbitrary step in its
  template. The target key must exist in the template.
- `kdi step <task_id> --reason <text>` records an optional reason on the
  `stepped` event.
- Step changes emit a `stepped` task event with the previous step, new step,
  and optional reason.
- `kdi show <task_id>` displays `Workflow template:` and `Current step:` when
  `FF_WORKFLOW_TEMPLATES` is enabled and the task is bound to a template.
- Existing `kdi list --workflow-template-id` and `--step-key` filters continue
  to work unchanged (they were added in KDI-030 and are gated by
  `FF_LIST_FILTERS_SORT`).
- All workflow template surfaces are rejected with a clear error when
  `FF_WORKFLOW_TEMPLATES` is disabled.

-------------------------------------------------------------------------------
Non-Functional Requirements
-------------------------------------------------------------------------------
- Template lookup by `(board_id, template_id)` must remain sub-millisecond for
  boards with 100 templates.
- Step advancement is synchronous and transactional.
- No breaking change to existing task status transitions when the flag is
  disabled.

-------------------------------------------------------------------------------
Feature Flag Requirements
-------------------------------------------------------------------------------
- `ff_workflow_templates` registered in `src/flags.ts`:
  ```ts
  export const FF_WORKFLOW_TEMPLATES = "FF_WORKFLOW_TEMPLATES";
  registerFlag(FF_WORKFLOW_TEMPLATES, false);
  ```
- Env var form: `FF_WORKFLOW_TEMPLATES=false`.
- Defaults to `false` in every environment.
- Gated surfaces:
  - `kdi workflows define`
  - `kdi workflows list`
  - `kdi create --workflow-template-id`
  - `kdi create --step-key` (when combined with `--workflow-template-id`)
  - `kdi step`
  - Workflow fields in `kdi show`

-------------------------------------------------------------------------------
Schema Changes
-------------------------------------------------------------------------------
Add a new `workflow_templates` table. The `tasks.workflow_template_id` and
`tasks.current_step_key` columns already exist from KDI-030; this BRD adds the
parent table that gives them meaning.

```ts
const hasWorkflowTemplates = db.query(
  "SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_templates'"
).get() as { 1: number } | undefined;
if (!hasWorkflowTemplates) {
  dbInstance.exec(`
    CREATE TABLE workflow_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id INTEGER NOT NULL REFERENCES boards(id),
      template_id TEXT NOT NULL,
      name TEXT NOT NULL,
      steps TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE (board_id, template_id)
    )
  `);
  dbInstance.exec("CREATE INDEX idx_workflow_templates_board ON workflow_templates(board_id)");
}
```

- `steps` is stored as a JSON array string.
- `template_id` is the user-facing identifier (e.g. `onboarding`).
- Board hard-delete cascade-deletes related `workflow_templates` rows.

-------------------------------------------------------------------------------
CLI Surface
-------------------------------------------------------------------------------
- `kdi workflows define <template_id> --name <name> --steps <json> [--board <slug>]`
- `kdi workflows list [--board <slug>] [--json]`
- `kdi create <title> ... [--workflow-template-id <id>] [--step-key <key>]`
- `kdi step <task_id> [--to <key>] [--reason <text>]`
- `kdi show <task_id>` (displays workflow fields when enabled)

-------------------------------------------------------------------------------
Model Behavior
-------------------------------------------------------------------------------
1. `WorkflowTemplate` interface:
   ```ts
   export interface WorkflowTemplate {
     id: number;
     board_id: number;
     template_id: string;
     name: string;
     steps: string[];
     created_at: number;
     updated_at: number;
   }
   ```
2. `defineWorkflowTemplate(board_id, template_id, name, steps)`:
   - Validate `template_id` matches `^[a-zA-Z0-9_-]+$`.
   - Validate `steps` is a non-empty array of unique non-empty strings.
   - Upsert on `(board_id, template_id)` conflict, updating `name`, `steps`,
     and `updated_at`.
3. `listWorkflowTemplates(board_id)`:
   - Return hydrated templates ordered by `template_id` ASC.
4. `getWorkflowTemplate(board_id, template_id)`:
   - Return the template or `null` if not found.
5. `validateStepKey(template, key)`:
   - Throw if `key` is not in `template.steps`.
6. `advanceTaskStep(task_id)`:
   - Load the task and its template.
   - Find the next step in `template.steps` after `task.current_step_key`.
   - If there is a next step, update `current_step_key` and emit `stepped`.
   - If the current step is the last step, transition the task to `done`,
     clear `current_step_key`, and emit `stepped` + `completed`.
7. `setTaskStep(task_id, targetKey, reason?)`:
   - Load the task and its template.
   - Validate `targetKey` is in `template.steps`.
   - Update `current_step_key` and emit `stepped`.

-------------------------------------------------------------------------------
Event Recording
-------------------------------------------------------------------------------
- New event kind: `stepped`.
- Payload: `{ from?: string; to?: string; reason?: string }`. `to` is omitted
  when the terminal step transitions to `done`; `from` is omitted when the
  task had no previous step.

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
- [x] `FF_WORKFLOW_TEMPLATES=true kdi workflows define onboarding --name
      "Onboarding" --steps '["setup","review","deploy"]' --board myproj`
      creates a template with three steps.
- [x] `FF_WORKFLOW_TEMPLATES=true kdi workflows list --board myproj` prints
      the onboarding template and its steps.
- [x] `FF_WORKFLOW_TEMPLATES=true kdi create "Onboard user" --board myproj
      --workflow-template-id onboarding` creates a task with
      `current_step_key = "setup"`.
- [x] `FF_WORKFLOW_TEMPLATES=true kdi create "Onboard user" --board myproj
      --workflow-template-id onboarding --step-key review` creates a task
      starting at the `review` step.
- [x] `FF_WORKFLOW_TEMPLATES=true kdi create "Onboard user" --board myproj
      --workflow-template-id onboarding --step-key missing` exits with a
      clear error that the step does not exist in the template.
- [x] `FF_WORKFLOW_TEMPLATES=true kdi step <task_id>` advances the task from
      `setup` to `review`.
- [x] `FF_WORKFLOW_TEMPLATES=true kdi step <task_id>` at the `deploy` step
      transitions the task to `done` and clears `current_step_key`.
- [x] `FF_WORKFLOW_TEMPLATES=true kdi step <task_id> --to setup` jumps the
      task back to the `setup` step.
- [x] `FF_WORKFLOW_TEMPLATES=true kdi step <task_id> --reason "fixed bug"`
      records the reason on the `stepped` event.
- [x] `FF_WORKFLOW_TEMPLATES=true kdi show <task_id>` displays the workflow
      template id and current step.
- [x] `FF_WORKFLOW_TEMPLATES=false kdi workflows define ...` exits with
      "Workflow templates feature is not enabled."
- [x] `FF_WORKFLOW_TEMPLATES=false kdi create "task" --workflow-template-id x`
      exits with the same gating error.
- [x] A board hard-delete removes its workflow templates.
- [x] Unit and CLI tests cover template CRUD, step advancement, terminal-step
      completion, validation errors, and flag gating.
- [x] When a task with `current_step_key` is claimed by the dispatcher, the active
      `task_runs` row records the step key.
- [x] The dispatcher substitutes `{{step_key}}` in harness profile commands for tasks
      that have a current step key.
- [x] The dispatcher sets `KDI_CURRENT_STEP_KEY=<key>` in the harness environment for
      tasks that have a current step key.
- [x] `kdi runs <task_id>` displays `step=<key>` for runs that recorded a step key.
- [x] Profile validation accepts `{{step_key}}` as a known template variable.

-------------------------------------------------------------------------------
Risks / Mitigations
-------------------------------------------------------------------------------
- **Risk:** Workflow templates add a new table and command namespace that
  overlap with the existing `tasks` workflow columns.
  **Mitigation:** This BRD builds on the KDI-030 schema without modifying it.
  The new `workflow_templates` table is the source of truth; task columns
  reference it.
- **Risk:** Step advancement could conflict with manual status changes.
  **Mitigation:** `kdi step` does not change status except at the terminal
  step, where it transitions to `done`. Operators can still use `kdi block`,
  `kdi unblock`, etc., independently.
- **Risk:** Defining a template with many steps could bloat the JSON column.
  **Mitigation:** Enforce a reasonable maximum step count (e.g. 100) and step
  key length (e.g. 255 characters).

-------------------------------------------------------------------------------
Dependencies
-------------------------------------------------------------------------------
- `src/models/task.ts` (`Task`, `TASK_COLUMNS`, `hydrateTask`, `showTask`).
- `src/models/taskEvent.ts` (`addEvent`).
- `src/commands/tasks.ts` (`kdi create`, `kdi show`).
- `src/commands/workflows.ts` (new file for `kdi workflows define/list`).
- `src/index.ts` (wire new commands).
- `src/db.ts` (new `workflow_templates` table and index).
- `src/flags.ts` (`FF_WORKFLOW_TEMPLATES`).
- `specs/feature-flags.md` (already registered; verify consistency).
