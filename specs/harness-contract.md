# KDI Harness Contract

> Authoritative contract between `kdi` and any harness CLI it dispatches
> (`opencode`, `pi`, `claude`, `codex`, or a custom profile). Authoritative
> implementation: `src/dispatcher.ts` (env export) and `src/profiles.ts`
> (template substitution). This document codifies what kdi promises.

## 1. Profile resolution

Profiles are loaded from `~/.config/kdi/profiles.yaml` (override with
`KDI_PROFILES_PATH`), merged with built-in profiles in `src/profiles.ts`
(`BUILTIN_PROFILES`). A task's harness profile is chosen by
`task.assignee` (defaulting to `opencode`). Unknown profile names fail fast.

Each profile has a `command` template string. kdi substitutes `{{template}}`
variables (see §3) and runs the resulting command in a per-task worktree.

## 2. Environment variables exported to the harness

kdi exports these to the harness process, each gated by its feature flag:

| Env var | When exported | Meaning |
|---|---|---|
| `KDI_TASK_ID` | `FF_HARNESS_CONTEXT=true` | The kdi task id. |
| `KDI_TASK_TITLE` | `FF_HARNESS_CONTEXT=true` | The task title. |
| `KDI_TASK_BODY` | `FF_HARNESS_CONTEXT=true` | The task body (may be empty). |
| `KDI_BOARD` | `FF_HARNESS_CONTEXT=true` | The board slug. |
| `KDI_RESULT_FILE` | `FF_RESULT_SUMMARY=true` | Absolute path inside the worktree where the harness should write a clean result. |
| `KDI_SKILLS` | set and `FF_SKILLS_ARRAY=true` | Comma-joined skills. |
| `KDI_MODEL` | set and `FF_MODEL_OVERRIDE=true` | Model override string. |
| `KDI_CURRENT_STEP_KEY` | set and `FF_WORKFLOW_TEMPLATES=true` | Current workflow step key. |
| `KDI_GOAL_MODE` | `FF_GOAL_MODE=true` and task is goal-mode | Always `"true"`. |
| `KDI_GOAL_MAX_TURNS` | (same as `KDI_GOAL_MODE`) | Total turn budget. |
| `KDI_GOAL_REMAINING_TURNS` | (same) | Turns remaining after this one. |
| `KDI_GOAL_TURN` | (same) | 1-indexed current turn. |
| `KDI_GOAL_CONTEXT` | (same) | Prior result carried into this turn. |
| `KDI_GOAL_VERDICT_FILE` | (same) | Absolute path where the judge writes its verdict. |

No other `KDI_*` env vars are part of this contract.

## 3. Template variables

These `{{name}}` tokens may appear in a profile `command` and are substituted
before spawn (`ALLOWED_TEMPLATES` in `src/profiles.ts`):

| Variable | Value |
|---|---|
| `{{workdir}}` | Absolute path of the per-task worktree. |
| `{{branch}}` | Worktree branch name (`wt/<profile>/<task_id>`). |
| `{{task_id}}` | Task id. |
| `{{agent}}` | `profile.agent` (or profile name). |
| `{{skills}}` | Comma-joined skills (empty when unset). |
| `{{model}}` | Model override (empty when unset). |
| `{{step_key}}` | Current workflow step key (empty when unset). |
| `{{title}}` | Task title (single-quote shell-escaped). |
| `{{body}}` | Task body (single-quote shell-escaped). |
| `{{result_file}}` | Result-file path (only when `FF_RESULT_SUMMARY=true`). |

A profile using any other `{{name}}` is rejected at load time.

## 4. Result-file convention

With `FF_RESULT_SUMMARY=true`, kdi sets `KDI_RESULT_FILE` to
`<worktree>/.kdi-result.txt`. The harness SHOULD write its clean final result
there. `extractHarnessResult()` reads `.kdi-result.txt` first; if absent it
falls back to the last JSON text chunk on stdout. The stored result/summary is
shown by `kdi show <id>` and `kdi runs <id>`.

## 5. Pre-dispatch binary guard (KDI-056)

With `FF_REAL_HARNESS_PROFILES=true`, the dispatcher resolves the profile's
leading binary token against `PATH` **before** claiming the task. If the
binary is missing the task is **not** claimed, no worktree is created, a
`profile_invalid` event is recorded (`{ profile, binary }`), and an
operator-facing message is written to the board log. The task stays `ready`.

Inspect and repair profiles with:

```
kdi profiles doctor          # report per-profile binary health
kdi profiles doctor --json   # machine-readable report
kdi profiles bootstrap       # write known-good opencode/pi entries if absent
kdi profiles bootstrap --force
```

kdi never downloads or installs the harness binaries; it only validates and
points the registry at them.