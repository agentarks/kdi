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
Background
-------------------------------------------------------------------------------
KDI tasks already move through a fixed status lifecycle (`triage`, `todo`,
`ready`, `running`, `done`, `blocked`, `review`, `scheduled`). For recurring
multi-stage work—such as onboarding, incident response, or code-review
pipelines—operators need a way to express stage sequences and route harnesses
according to the current stage. Hermes Kanban exposes `workflow_template_id`
and `current_step_key` for this purpose; KDI-030 added the corresponding task
columns and list filters. This BRD introduces the parent `workflow_templates`
table, the CLI surface to manage templates and step through them, and the
step-key driven routing that flows `current_step_key` into harness execution.

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
6. As a harness author, I can receive the current step key via a profile
   template variable and an environment variable so that the same profile can
   behave differently per step.

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
  to work unchanged (added in KDI-030; gated by `FF_LIST_FILTERS_SORT`).
- Step-key driven routing: when the dispatcher claims a ready task that has a
  `current_step_key`, the active `task_runs` row records that step key, the
  harness profile command may use `{{step_key}}` substitution, and the harness
  process receives `KDI_CURRENT_STEP_KEY=<key>` in its environment.
- `kdi runs <task_id>` displays `step=<key>` for any run that recorded a step
  key.
- All workflow template surfaces are rejected with a clear error when
  `FF_WORKFLOW_TEMPLATES` is disabled.

-------------------------------------------------------------------------------
Non-Functional Requirements
-------------------------------------------------------------------------------
- Template lookup by `(board_id, template_id)` must remain sub-millisecond for
  boards with 100 templates.
- Step advancement is synchronous and transactional.
- Step-key routing adds no extra database round-trips beyond the existing
  claim query.
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
`tasks.current_step_key` columns are added by KDI-030; this BRD depends on them
and adds the parent table that gives them meaning.

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
- `kdi runs <task_id>` (displays `step=<key>` when a run recorded one)

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
   - Validate `steps` is a non-empty array of unique non-empty strings,
     bounded to a maximum count (e.g. 100) and step-key length (e.g. 255).
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
Step-Key Driven Routing
-------------------------------------------------------------------------------
When the dispatcher claims a ready task:
1. `atomicClaim` selects `tasks.current_step_key` alongside
   `max_runtime_seconds` and writes `step_key` into the new `task_runs` row.
2. The dispatcher builds the harness command with `substituteCommand`, passing
   `step_key: task.current_step_key ?? ""`. Profile commands may contain
   `{{step_key}}`.
3. If the task has a non-empty `current_step_key`, the dispatcher adds
   `KDI_CURRENT_STEP_KEY=<key>` to the harness environment.
4. Profile validation (`validateProfile`) accepts `{{step_key}}` as a known
   template variable.

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
- [ ] `FF_WORKFLOW_TEMPLATES=true kdi workflows define onboarding --name
      "Onboarding" --steps '["setup","review","deploy"]' --board myproj`
      creates a template with three steps.
- [ ] `FF_WORKFLOW_TEMPLATES=true kdi workflows list --board myproj` prints
      the onboarding template and its steps.
- [ ] `FF_WORKFLOW_TEMPLATES=true kdi create "Onboard user" --board myproj
      --workflow-template-id onboarding` creates a task with
      `current_step_key = "setup"`.
- [ ] `FF_WORKFLOW_TEMPLATES=true kdi create "Onboard user" --board myproj
      --workflow-template-id onboarding --step-key review` creates a task
      starting at the `review` step.
- [ ] `FF_WORKFLOW_TEMPLATES=true kdi create "Onboard user" --board myproj
      --workflow-template-id onboarding --step-key missing` exits with a
      clear error that the step does not exist in the template.
- [ ] `FF_WORKFLOW_TEMPLATES=true kdi step <task_id>` advances the task from
      `setup` to `review`.
- [ ] `FF_WORKFLOW_TEMPLATES=true kdi step <task_id>` at the `deploy` step
      transitions the task to `done` and clears `current_step_key`.
- [ ] `FF_WORKFLOW_TEMPLATES=true kdi step <task_id> --to setup` jumps the
      task back to the `setup` step.
- [ ] `FF_WORKFLOW_TEMPLATES=true kdi step <task_id> --reason "fixed bug"`
      records the reason on the `stepped` event.
- [ ] `FF_WORKFLOW_TEMPLATES=true kdi show <task_id>` displays the workflow
      template id and current step.
- [ ] `FF_WORKFLOW_TEMPLATES=false kdi workflows define ...` exits with
      "Workflow templates feature is not enabled."
- [ ] `FF_WORKFLOW_TEMPLATES=false kdi create "task" --workflow-template-id x`
      exits with the same gating error.
- [ ] A board hard-delete removes its workflow templates.
- [ ] When a task with `current_step_key` is claimed by the dispatcher, the
      active `task_runs` row records the step key.
- [ ] The dispatcher substitutes `{{step_key}}` in harness profile commands for
      tasks that have a current step key.
- [ ] The dispatcher sets `KDI_CURRENT_STEP_KEY=<key>` in the harness
      environment for tasks that have a current step key.
- [ ] `kdi runs <task_id>` displays `step=<key>` for runs that recorded a step
      key.
- [ ] Profile validation accepts `{{step_key}}` as a known template variable.
- [ ] Unit and CLI tests cover template CRUD, step advancement, terminal-step
      completion, validation errors, flag gating, dispatcher routing, and
      runs display.

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
- **Risk:** Harness profiles that do not expect `{{step_key}}` or
  `KDI_CURRENT_STEP_KEY` are unaffected; absent values substitute to empty
  string and omit the env var.

-------------------------------------------------------------------------------
Migration Notes
-------------------------------------------------------------------------------
- Fresh databases create `workflow_templates` directly via the baseline schema.
- Existing databases add the table idempotently on the next `kdi` invocation
  using the `sqlite_master` guard shown above.
- `tasks.workflow_template_id` and `tasks.current_step_key` are created by
  KDI-030 migrations; this feature assumes they already exist.

-------------------------------------------------------------------------------
Dependencies
-------------------------------------------------------------------------------
- `src/models/task.ts` (`Task`, `TASK_COLUMNS`, `hydrateTask`, `showTask`).
- `src/models/taskEvent.ts` (`addEvent`).
- `src/models/taskRun.ts` (`createRun`, `TaskRun`, run columns).
- `src/models/claim.ts` (`atomicClaim`).
- `src/commands/tasks.ts` (`kdi create`, `kdi show`, `kdi runs`).
- `src/commands/workflows.ts` (new file for `kdi workflows define/list`).
- `src/dispatcher.ts` (harness command substitution and env vars).
- `src/profiles.ts` (`substituteCommand`, `validateProfile`).
- `src/index.ts` (wire new commands).
- `src/db.ts` (new `workflow_templates` table and index).
- `src/flags.ts` (`FF_WORKFLOW_TEMPLATES`).
- `specs/feature-flags.md` (registry entry for `ff_workflow_templates`).
