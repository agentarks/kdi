# BRD-KDI-040: Triage Automation (LLM-powered)

-------------------------------------------------------------------------------
Business Goal
-------------------------------------------------------------------------------
Reduce manual triage overhead by letting an auxiliary LLM turn vague triage
cards into actionable work. `kdi specify` enriches a triage task (title, body,
assignee) and promotes it to `todo`. `kdi decompose` fans a triage task out
into a child task graph with dependency edges. Both commands support `--all`
sweeps and tenant-scoped sweeps, matching the Hermes Kanban triage automation
intent while extending the existing `kdi specify` command instead of replacing
it.

-------------------------------------------------------------------------------
User Stories
-------------------------------------------------------------------------------
1. As an operator, I can run `kdi specify <task_id>` on a triage card so an
   auxiliary LLM fleshes out the body (and optionally title and assignee) and
   promotes the card to `todo`.
2. As an operator, I can run `kdi decompose <task_id>` on a triage epic so an
   auxiliary LLM fans it out into child tasks linked by dependencies.
3. As an operator, I can use `--all` with either command to sweep every triage
   task on the current board in one invocation.
4. As an operator, I can use `--tenant <name>` with `--all` to restrict the
   sweep to triage tasks in a specific tenant namespace.
5. As an operator, I want the existing manual `kdi specify` behavior to remain
   available when the LLM feature is disabled or when I pass `--skip-llm`.
6. As an operator, I want a failed LLM call (bad JSON, timeout, missing config)
   to block the task with a clear reason rather than silently promoting it.

-------------------------------------------------------------------------------
Non-Goals
-------------------------------------------------------------------------------
- Autonomous dispatcher-driven triage (the operator still invokes the
  command).
- Multi-turn refinement loops or interactive LLM prompting.
- LLM-powered rewrites of tasks that are already `todo` or beyond.
- General-purpose chat or Q&A with the task database.
- Changing the existing `triage` CHECK constraint or task lifecycle states.
- Storing per-task LLM conversation history.

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------
- `FF_TRIAGE_AUTOMATION` gates all LLM-powered behavior. When the flag is
  disabled, `kdi decompose` and the LLM path of `kdi specify` are rejected.
- The existing `kdi specify <task_id>` manual promotion path remains ungated
  and unchanged: it requires a non-empty body and promotes `triage` → `todo`.
- When `FF_TRIAGE_AUTOMATION` is enabled, `kdi specify <task_id>` invokes the
  auxiliary LLM by default. The LLM receives the task's title, body, assignee,
  tenant, and board slug and returns a structured JSON response.
- `kdi specify <task_id> --skip-llm` bypasses the LLM and uses the existing
  manual promotion logic (requires a non-empty body).
- `kdi specify --all` processes every `triage` task on the resolved board.
  With the flag enabled it uses the LLM; with the flag disabled it uses the
  existing manual promotion logic.
- `kdi specify --all --tenant <name>` restricts the sweep to `triage` tasks
  whose `tenant` column equals `<name>`. `--tenant` is accepted only when
  `FF_TRIAGE_AUTOMATION` is enabled.
- The LLM response for `specify` must contain at least `body`. Optional fields
  `title` and `assignee` may update the task. After a successful LLM call the
  task is promoted to `todo` and a `specified` event is recorded with payload
  `{ llm: true }`.
- If the LLM response is missing `body`, is not valid JSON, or the LLM call
  fails, the task is left in `triage` and blocked with reason
  `"LLM specify failed: <details>"`. A `blocked` event is emitted with the same
  reason.
- `kdi decompose <task_id>` works only on `triage` tasks. It calls the
  auxiliary LLM with the task's context and expects a child-graph JSON
  response.
- The LLM response for `decompose` contains `children`, an array of 2–10 child
  objects. Each child object has a required `title` and optional `body`,
  `assignee`, and `dependencies` (an array of zero-based indices of other
  children that must complete first).
- Child tasks are created in `todo` status on the same board as the parent,
  inheriting the parent's `tenant`. Child `assignee` defaults to the parent's
  assignee when the LLM omits it.
- After all children are created, dependency edges are added using the existing
  `addDependency(parentId, childId)` semantics: for each child at index `i`
  and each dependency index `j` in `children[i].dependencies`, call
  `addDependency(childIds[j], childIds[i])`.
- Once children and dependencies are persisted, the original triage task is
  archived (soft) and a `decomposed` event is recorded on the parent with
  payload `{ child_ids, child_count }`.
- Invalid child indices, self-dependencies, or circular dependencies from the
  LLM cause the entire decomposition to abort; the parent is blocked with
  reason `"LLM decomposition failed: <details>"` and no children are created.
- The auxiliary LLM is invoked via an OpenAI-compatible chat completions
  endpoint configured through environment variables:
  - `KDI_TRIAGE_LLM_API_KEY` — required API key.
  - `KDI_TRIAGE_LLM_BASE_URL` — optional base URL (default
    `https://api.openai.com/v1`).
  - `KDI_TRIAGE_LLM_MODEL` — optional model name (default `gpt-4o-mini`).
  - `KDI_TRIAGE_LLM_TIMEOUT_MS` — optional request timeout in milliseconds
    (default `60000`).
- If required LLM configuration is missing, the command exits with a clear
  error before mutating state.
- The diagnostic rule `triage_aux_unavailable` continues to apply to triage
  tasks that remain unprocessed; successful `specify` or `decompose` removes
  the finding by changing the task state or adding body/assignee.

-------------------------------------------------------------------------------
Non-Functional Requirements
-------------------------------------------------------------------------------
- No database schema changes; reuse existing `tasks`, `dependencies`, and
  `task_events` tables.
- CLI response time remains sub-100ms when the LLM is not invoked (flag
  disabled or `--skip-llm`).
- LLM calls are synchronous and bounded by `KDI_TRIAGE_LLM_TIMEOUT_MS`
  (default 60s).
- LLM response size is capped at 32 KiB to avoid unbounded JSON parsing.
- Child graph output is capped at 10 children to prevent runaway decomposition.
- All LLM-driven mutations are transactional where SQLite transactions cover
  child creation, dependency insertion, and parent archival.
- No new runtime dependencies; use Bun's native `fetch` for the LLM call.

-------------------------------------------------------------------------------
Feature Flag Requirements
-------------------------------------------------------------------------------
- `ff_triage_automation` registered in `src/flags.ts`:
  ```ts
  export const FF_TRIAGE_AUTOMATION = "FF_TRIAGE_AUTOMATION";
  registerFlag(FF_TRIAGE_AUTOMATION, false);
  ```
- Env var form: `FF_TRIAGE_AUTOMATION=false`.
- Defaults to `false` in every environment.
- Gated surfaces:
  - `kdi decompose`
  - LLM path of `kdi specify` (default when flag enabled)
  - `kdi specify --tenant <name>`
- `--skip-llm` and the base manual `kdi specify` path remain ungated.

-------------------------------------------------------------------------------
Schema Changes
-------------------------------------------------------------------------------
None. This BRD reuses the existing `tasks`, `dependencies`, and `task_events`
tables. No columns, indexes, or CHECK constraints are added or modified.

-------------------------------------------------------------------------------
CLI Surface
-------------------------------------------------------------------------------
- `kdi specify [task_id] [--all] [--board <slug>] [--tenant <name>] [--skip-llm]`
  — promote a triage task to `todo`, using the auxiliary LLM when the feature
  flag is enabled and `--skip-llm` is not passed.
- `kdi decompose <task_id> [--board <slug>]` — fan a triage task out into a
  child task graph via the auxiliary LLM.
- `kdi decompose --all [--board <slug>] [--tenant <name>]` — sweep all triage
  tasks on the resolved board and decompose each one.

-------------------------------------------------------------------------------
Model / API Changes
-------------------------------------------------------------------------------
1. New file `src/llm.ts` (or `src/triageLlm.ts`) exposes:
   - `callTriageLlm(prompt: LlmPrompt): Promise<LlmResponse>` — makes the
     OpenAI-compatible chat completions request, enforces the timeout, and
     parses the JSON response.
   - `buildSpecifyPrompt(task: Task): LlmPrompt`
   - `buildDecomposePrompt(task: Task): LlmPrompt`
2. `src/models/task.ts` adds:
   - `specifyTaskWithLlm(id: number, options?: { skipLlm?: boolean }): Task`
     — LLM-aware wrapper that falls back to the existing `specifyTask()` when
     `skipLlm` is true.
   - `decomposeTask(id: number, decomposition: DecompositionInput): Task[]` —
     creates child tasks, dependencies, archives the parent, and emits a
     `decomposed` event. Returns the created child tasks.
3. `src/models/dependency.ts` is reused unchanged; `addDependency()` provides
   self-dependency and circular-dependency validation.
4. `src/models/taskEvent.ts` `addEvent()` is used directly with kinds
   `"specified"` and `"decomposed"` and the payloads described above.

-------------------------------------------------------------------------------
LLM Prompt / Output Contract
-------------------------------------------------------------------------------
Both prompts request a single JSON object on the last line with no markdown
fences.

### `specify` prompt (sent to the model)

```
You are a task specifier for a Kanban dispatch system.
A task is currently in "triage" status and needs a clear, actionable body
before it can be promoted to "todo".

Return a single JSON object with no markdown formatting:
{
  "body": "<detailed, actionable body>",
  "title": "<optional refined title>",
  "assignee": "<optional profile name>"
}

Only "body" is required. If the existing title or assignee is already
sensible, omit those fields to keep them unchanged.

Existing task context:
- board: <board_slug>
- title: <task_title>
- body: <task_body_or_empty>
- assignee: <assignee_or_empty>
- tenant: <tenant_or_empty>
```

### `specify` output schema

```json
{
  "body": "string (required, non-empty)",
  "title": "string (optional)",
  "assignee": "string (optional)"
}
```

### `decompose` prompt (sent to the model)

```
You are a task decomposer for a Kanban dispatch system.
A task is currently in "triage" status and is too large to execute as-is.
Break it into 2-10 smaller child tasks that can be worked independently.

Return a single JSON object with no markdown formatting:
{
  "children": [
    {
      "title": "<child title>",
      "body": "<optional detailed body>",
      "assignee": "<optional profile name>",
      "dependencies": [<optional array of zero-based indices of children that must finish before this one>]
    }
  ]
}

Use dependencies only when a child genuinely cannot start until another
child finishes. A child may not depend on itself. Keep the graph acyclic.

Parent task context:
- board: <board_slug>
- title: <task_title>
- body: <task_body_or_empty>
- assignee: <assignee_or_empty>
- tenant: <tenant_or_empty>
```

### `decompose` output schema

```json
{
  "children": [
    {
      "title": "string (required, non-empty)",
      "body": "string (optional)",
      "assignee": "string (optional)",
      "dependencies": [0, 1] // optional, zero-based indices of prerequisite children
    }
  ]
}
```

Constraints enforced by kdi after receiving the response:
- `children` length must be between 2 and 10 inclusive.
- Each child must have a non-empty `title`.
- `dependencies` indices must be valid and refer only to other children in
  the same response.
- No self-dependencies and no circular dependencies.

-------------------------------------------------------------------------------
Event Recording
-------------------------------------------------------------------------------
- Existing `task_events` table is reused.
- `specified` event (already emitted by manual specify) gains an optional
  payload `{ llm: true }` when the LLM path succeeds.
- New event kind: `decomposed`.
- Payload shape for `decomposed`:
  ```json
  { "child_ids": [12, 13, 14], "child_count": 3 }
  ```
- Existing `blocked` event is emitted when an LLM call fails or the response
  is invalid, with `{ reason: "LLM specify failed: ..." }` or
  `{ reason: "LLM decomposition failed: ..." }`.

-------------------------------------------------------------------------------
Error Handling
-------------------------------------------------------------------------------
- `kdi specify` / `kdi decompose` when `FF_TRIAGE_AUTOMATION=false` exit with
  "Triage automation feature is not enabled." (base manual `kdi specify`
  remains available).
- `kdi specify --tenant <name>` when `FF_TRIAGE_AUTOMATION=false` exits with
  the same gating error.
- Missing `KDI_TRIAGE_LLM_API_KEY` exits with
  "Triage LLM API key is not configured (KDI_TRIAGE_LLM_API_KEY)."
- `kdi specify` on a non-triage task exits with
  "Task <id> is not in triage status."
- `kdi decompose` on a non-triage task exits with the same error.
- Invalid LLM JSON or missing required fields blocks the task with reason
  "LLM specify failed: <details>" or "LLM decomposition failed: <details>".
- LLM request timeout blocks the task with reason
  "LLM specify failed: request timed out" or similar.
- Invalid child dependency indices, self-dependencies, or cycles abort the
  decomposition and block the parent; no child tasks are created.

-------------------------------------------------------------------------------
Testing Requirements
-------------------------------------------------------------------------------
- Unit tests for `src/llm.ts`:
  - successful JSON response parsing for specify and decompose;
  - timeout handling;
  - non-JSON / malformed response handling;
  - missing API key error.
- Unit tests for `specifyTaskWithLlm`:
  - LLM success updates body/title/assignee and promotes to `todo`;
  - `--skip-llm` uses manual promotion and requires body;
  - invalid LLM response blocks the task;
  - non-triage task is rejected.
- Unit tests for `decomposeTask`:
  - successful decomposition creates children, dependencies, archives parent,
    and emits `decomposed`;
  - invalid child indices / self-dependency / cycle abort and block parent;
  - non-triage parent is rejected.
- CLI/e2e tests for flag gating, `--all`, `--tenant`, and error messages.
- All existing tests continue to pass with `FF_TRIAGE_AUTOMATION=false`.

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
- [ ] AC-01: `FF_TRIAGE_AUTOMATION=false kdi specify <id>` still performs the
      existing manual promotion from `triage` to `todo` when the body is
      non-empty.
- [ ] AC-02: `FF_TRIAGE_AUTOMATION=false kdi decompose <id>` exits with
      "Triage automation feature is not enabled."
- [ ] AC-03: `FF_TRIAGE_AUTOMATION=true kdi specify <id>` on a triage task
      calls the auxiliary LLM, updates the body, promotes the task to `todo`,
      and records a `specified` event with payload `{ llm: true }`.
- [ ] AC-04: `FF_TRIAGE_AUTOMATION=true kdi specify <id>` on a triage task
      whose LLM response includes `title` and `assignee` updates both fields.
- [ ] AC-05: `FF_TRIAGE_AUTOMATION=true kdi specify <id>` on a task without a
      body uses the LLM-generated body for promotion.
- [ ] AC-06: `FF_TRIAGE_AUTOMATION=true kdi specify <id> --skip-llm` uses the
      manual promotion path and requires a non-empty body.
- [ ] AC-07: `FF_TRIAGE_AUTOMATION=true kdi specify --all` sweeps every triage
      task on the resolved board, processing each with the LLM.
- [ ] AC-08: `FF_TRIAGE_AUTOMATION=true kdi specify --all --tenant foo`
      processes only triage tasks whose `tenant` is `foo`.
- [ ] AC-09: `FF_TRIAGE_AUTOMATION=true kdi specify <id>` with an LLM response
      missing `body` blocks the task with reason
      "LLM specify failed: missing body in response".
- [ ] AC-10: `FF_TRIAGE_AUTOMATION=true kdi decompose <id>` on a triage task
      creates 2–10 child tasks in `todo`, adds the requested dependencies,
      archives the parent, and records a `decomposed` event with the child IDs.
- [ ] AC-11: `FF_TRIAGE_AUTOMATION=true kdi decompose <id>` child tasks
      inherit the parent's `tenant` and default to the parent's `assignee`
      when the LLM omits them.
- [ ] AC-12: `FF_TRIAGE_AUTOMATION=true kdi decompose <id>` with an LLM
      response containing a self-dependency or cycle blocks the parent and
      creates no children.
- [ ] AC-13: `FF_TRIAGE_AUTOMATION=true kdi decompose --all --tenant foo`
      decomposes every triage task with tenant `foo` on the resolved board.
- [ ] AC-14: `kdi specify` and `kdi decompose` reject non-numeric or missing
      task IDs with the same validation message used by other task commands.
- [ ] AC-15: Missing `KDI_TRIAGE_LLM_API_KEY` causes both commands to exit
      with a clear configuration error before mutating state.
- [ ] AC-16: `bun run lint` and `bun run build` pass after implementation.
- [ ] AC-17: `bun run test` passes (or matches the existing baseline noted in
      `STATUS.md` Tech Debt) with the new tests added.

-------------------------------------------------------------------------------
Risks / Mitigations
-------------------------------------------------------------------------------
- **Risk:** LLM responses may be malformed, causing tasks to be blocked.
  **Mitigation:** strict JSON schema validation, clear block reasons, and a
  `--skip-llm` escape hatch.
- **Risk:** LLM calls add latency and cost to a previously cheap CLI command.
  **Mitigation:** synchronous call with configurable timeout; default model is
  a small/cheap model; feature is opt-in via flag.
- **Risk:** Decomposition could create many children or deep dependency chains.
  **Mitigation:** cap children at 10 and validate acyclic graphs using the
  existing `addDependency()` checks.
- **Risk:** Archiving the parent task after decomposition removes it from
  active views.
  **Mitigation:** the `decomposed` event and child task IDs preserve an audit
  trail; future work can keep a parent container if needed.
- **Risk:** Diagnostics `triage_aux_unavailable` may still flag tasks that are
  waiting for automation.
  **Mitigation:** the rule applies only to tasks older than one hour lacking
  body/assignee; running `specify`/`decompose` resolves the finding.

-------------------------------------------------------------------------------
Open Questions
-------------------------------------------------------------------------------
- Should the default model remain `gpt-4o-mini` or should kdi ship a built-in
  local-profile fallback for air-gapped environments?
- Should `kdi decompose` keep the parent task as a tracking container
  (e.g., a new `epic` status) instead of archiving it?
- Should successful `specify` also generate a short `summary` field for
  `kdi show`, or is `body` sufficient?

-------------------------------------------------------------------------------
Dependencies
-------------------------------------------------------------------------------
- `src/flags.ts` — register `FF_TRIAGE_AUTOMATION`.
- `src/commands/tasks.ts` — extend `specifyTaskCommand` and add
  `decomposeTaskCommand`.
- `src/index.ts` — wire the new `decompose` command.
- `src/models/task.ts` — add `specifyTaskWithLlm()` and `decomposeTask()`.
- `src/models/dependency.ts` — reuse `addDependency()` for child graphs.
- `src/models/taskEvent.ts` — emit `specified` (with optional `{ llm: true }`)
  and `decomposed` events.
- `src/llm.ts` (new) — OpenAI-compatible LLM client and prompt builders.
- `specs/feature-flags.md` — register `ff_triage_automation`.
