# BRD-KDI-010: Per-Task Model Override

-------------------------------------------------------------------------------
Business Goal
-------------------------------------------------------------------------------
Allow operators to override the LLM/model used by a task harness on a
per-task basis. This lets high-value or specialized tasks target a specific
model without changing the global profile or board configuration. The
dispatcher passes the override to the harness through both profile command
template substitution (`{{model}}`) and the `KDI_MODEL` environment variable.

-------------------------------------------------------------------------------
User Stories
-------------------------------------------------------------------------------
1. As an operator, I can specify a model override when creating a task.
2. As a harness author, I can use `{{model}}` in a profile command to receive
   the requested model identifier.
3. As a harness author, I can read `KDI_MODEL` from the environment inside my
   agent wrapper.
4. As a reviewer, I can see the model override on a task via `kdi show`.

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------
- `model_override TEXT` column on `tasks` stores the requested model
  identifier.
- `kdi create` accepts an optional `--model <model>` argument.
- Empty `--model` values are rejected with a clear error.
- `kdi show <id>` displays `Model override: <model>` when the flag is enabled
  and a value is set.
- Profile commands may contain the `{{model}}` template variable.
- The dispatcher substitutes `{{model}}` with the task's model override (empty
  string if no override is set).
- The dispatcher sets the `KDI_MODEL` env var when a model override is
  non-empty.
- The feature is gated behind `ff_model_override` and defaults to `false`.
- When the flag is disabled, the CLI must reject `--model` with a clear error.
- Existing tasks created before this feature must have `model_override = NULL`.

-------------------------------------------------------------------------------
Non-Functional Requirements
-------------------------------------------------------------------------------
- CLI response time remains sub-100ms.
- No breaking change to existing `create` or `show` output when the feature
  flag is disabled.
- Migration is idempotent and does not break existing databases.

-------------------------------------------------------------------------------
Feature Flag Requirements
-------------------------------------------------------------------------------
- `ff_model_override` registered in `specs/feature-flags.md`.
- Env var form: `FF_MODEL_OVERRIDE=false`.
- Defaults to `false` in all environments.

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
- [x] `FF_MODEL_OVERRIDE=true kdi create "x" --board b --model gpt-5.5`
      stores `model_override = gpt-5.5` and returns a task ID.
- [x] `FF_MODEL_OVERRIDE=true kdi show <id>` prints `Model override: gpt-5.5`.
- [x] A profile command `opencode run -m {{model}}` receives
      `opencode run -m gpt-5.5`.
- [x] The harness env contains `KDI_MODEL=gpt-5.5`.
- [x] `FF_MODEL_OVERRIDE=false kdi create "x" --board b --model gpt-5.5`
      fails with "Model override feature is not enabled."
- [x] `kdi create "x" --board b --model ""` fails with "Model cannot be empty."
- [x] Unit/e2e tests cover model storage, flag gating, template substitution,
      env passing, and absence of `KDI_MODEL` when no override is set.

-------------------------------------------------------------------------------
Risks and Mitigations
-------------------------------------------------------------------------------
- Risk: User-controlled model identifiers are interpolated into shell
  commands, enabling command injection.
  Mitigation: model override is substituted only into profile commands and
  passed as an env var; the dispatcher already runs profile commands with
  `shell: true`, so model values must be treated as untrusted input by harness
  authors. The CLI rejects empty values.
- Risk: Existing tasks lack the `model_override` column and crash during
  hydration.
  Mitigation: add an `ALTER TABLE tasks ADD COLUMN model_override TEXT`
  migration guarded by `PRAGMA table_info(tasks)`.

-------------------------------------------------------------------------------
Dependencies
-------------------------------------------------------------------------------
- Task model and CLI (`kdi create`, `kdi show`).
- Profile loader and template substitution (`src/profiles.ts`).
- Dispatcher harness invocation (`src/dispatcher.ts`).
- Feature flag registry (`src/flags.ts`).
