# BRD-KDI-009: Skills Array

-------------------------------------------------------------------------------
Business Goal
-------------------------------------------------------------------------------
Allow operators to attach a list of skill identifiers to a task so that
harness profiles can receive structured hints about which capabilities the
agent should load (e.g., `github`, `code-review`, `playwright`). Skills are
passed to the harness both through profile command template substitution
(`{{skills}}`) and via the `KDI_SKILLS` environment variable.

-------------------------------------------------------------------------------
User Stories
-------------------------------------------------------------------------------
1. As an operator, I can tag a task with one or more skills at creation time.
2. As a harness author, I can use `{{skills}}` in a profile command to
   receive a comma-separated list of skills.
3. As a harness author, I can read `KDI_SKILLS` from the environment inside
   my agent wrapper.
4. As a reviewer, I can see the skills attached to a task in `kdi show`.

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------
- `skills TEXT` column on `tasks` stores a JSON array of skill identifiers.
- `kdi create` accepts a repeatable `--skill <skill>` option.
- Empty `--skill` values are silently ignored.
- `kdi show <id>` displays skills as a comma-separated list when present.
- Profile commands may contain the `{{skills}}` template variable.
- The dispatcher substitutes `{{skills}}` with the comma-separated skill list
  (empty string if no skills).
- The dispatcher sets the `KDI_SKILLS` env var when skills are non-empty.
- Skill names are restricted to `^[a-zA-Z0-9_-]+$` to prevent command
  injection through `{{skills}}` substitution into `shell: true` commands.
- The feature is gated behind `ff_skills_array` and defaults to `false`.
- When the flag is disabled, the CLI must reject `--skill` with a clear error.
- Existing tasks created before this feature must have `skills = []`
  (hydrated from NULL).

-------------------------------------------------------------------------------
Non-Functional Requirements
-------------------------------------------------------------------------------
- CLI response time remains sub-100ms.
- No breaking change to existing `create` or `show` output when the feature
  flag is disabled.
- Malformed values in the `skills` column are handled defensively
  (non-array JSON or non-JSON text falls back to an empty array).

-------------------------------------------------------------------------------
Feature Flag Requirements
-------------------------------------------------------------------------------
- `ff_skills_array` registered in `specs/feature-flags.md`.
- Env var form: `FF_SKILLS_ARRAY=false`.
- Defaults to `false` in all environments.

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
- [ ] `FF_SKILLS_ARRAY=true kdi create "x" --board b --skill github
      --skill code-review` stores the skills array and returns a task ID.
- [ ] `FF_SKILLS_ARRAY=true kdi show <id>` prints `Skills: github, code-review`.
- [ ] A profile command `opencode run --skills {{skills}}` receives
      `opencode run --skills github,code-review`.
- [ ] The harness env contains `KDI_SKILLS=github,code-review`.
- [ ] `FF_SKILLS_ARRAY=true kdi create "x" --board b --skill "bad;cmd"`
      fails with a clear validation error and does not create the task.
- [ ] `FF_SKILLS_ARRAY=false kdi create "x" --board b --skill github`
      fails with "Skills array feature is not enabled."
- [ ] Unit/e2e tests cover skill storage, hydration, flag gating, template
      substitution, env passing, and invalid skill-name rejection.

-------------------------------------------------------------------------------
Risks and Mitigations
-------------------------------------------------------------------------------
- Risk: User-controlled skill values are interpolated into shell commands,
  enabling command injection.
  Mitigation: validate skill names against a strict allowlist and substitute
  only into profile commands, never into raw shell strings constructed from
  other user input.
- Risk: Existing tasks lack the `skills` column and crash during hydration.
  Mitigation: add an `ALTER TABLE tasks ADD COLUMN skills TEXT` migration and
  treat NULL/malformed values as an empty array in `hydrateTask`.

-------------------------------------------------------------------------------
Dependencies
-------------------------------------------------------------------------------
- Task model and CLI (`kdi create`, `kdi show`).
- Profile loader and template substitution (`src/profiles.ts`).
- Dispatcher harness invocation (`src/dispatcher.ts`).
- Feature flag registry (`src/flags.ts`).
