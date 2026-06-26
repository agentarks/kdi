# BRD-KDI-056: Ship Real Pi/opencode Harness Profiles

-------------------------------------------------------------------------------
Business Goal
-------------------------------------------------------------------------------
Make `kdi` dispatch real, installed agent CLIs (`opencode`, `pi`) reliably out of
the box, and give operators a single command to repair or validate the
user-level profile registry when it drifts to stale test harnesses. Today a
fresh `kdi` install can silently dispatch against a stale `/tmp/mock-harness`
override and block every task with `exit 127` before anyone notices.

-------------------------------------------------------------------------------
Problem Statement
-------------------------------------------------------------------------------
KDI resolves harness profiles from `~/.config/kdi/profiles.yaml` (falling back to
`BUILTIN_PROFILES` in `src/profiles.ts`). The file is user-editable, so a prior
test session can leave an entry pointing at a deleted path (observed:
`/tmp/mock-harness`). The dispatcher has no pre-spawn guard: it substitutes the
command, spawns it, and only learns the binary is missing when the harness exits
`127`. The operator gets a `spawn_failed`/`crashed` run and no guidance on how to
fix the profile. There is also no documented contract for the env vars
(`KDI_TASK_*`, `KDI_RESULT_FILE`) and template variables (`{{title}}`, `{{body}}`,
`{{result_file}}`) that KDI promises to a real harness.

-------------------------------------------------------------------------------
User-Visible Decision Options
-------------------------------------------------------------------------------
1. **Bootstrap + doctor + contract doc.** Add `kdi profiles bootstrap` to write
   known-good real profiles, `kdi profiles doctor` to validate them, reject
   dispatch when validation fails, and document the harness contract. Highest
   operator value; one new command group.
2. **Doctor only.** Validate and report, but never write the registry. Operator
   repairs by hand. Smaller surface, but leaves the exit-127 trap in place for
   new installs.
3. **Pre-dispatch guard only.** Skip `bootstrap`/`doctor`; just refuse to spawn
   a profile whose binary is missing and emit a clear error. Minimal, but the
   registry still rots silently and there is no contract doc.

-------------------------------------------------------------------------------
Chosen Recommendation
-------------------------------------------------------------------------------
Choose option 1. It removes the exit-127 trap end to end: `bootstrap` repairs the
registry, `doctor` validates it, the dispatcher refuses to spawn unvalidated
profiles, and a single doc codifies the `$KDI_TASK_*` / `$KDI_RESULT_FILE` /
template contract so real `opencode`/`pi` integrations are reproducible. The
whole feature is additive and gated behind a new flag defaulting to `false`.

-------------------------------------------------------------------------------
Current Behavior vs Desired Behavior
-------------------------------------------------------------------------------
| Aspect | Current | Desired |
|---|---|---|
| Stale profile binary | Spawns, fails `exit 127`, task crashes | `doctor` reports it; dispatch refuses with a clear fix hint |
| Repair path | None; edit YAML by hand | `kdi profiles bootstrap` rewrites known-good real profiles |
| Built-in `opencode`/`pi` commands | Hardcoded, may not match installed CLI | Documented contract; `bootstrap` aligns registry to contract |
| Pre-spawn validation | None | Dispatcher validates binary exists before claiming a task |
| Harness env/template contract | Spread across `profiles.ts` + `dispatcher.ts` | One doc section lists every `KDI_*` env var and `{{template}}` |
| Feature gating | N/A | `ff_real_harness_profiles` / `FF_REAL_HARNESS_PROFILES`, default `false` |

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------
- **FR-1 (bootstrap):** `kdi profiles bootstrap [--force]` writes known-good
  `opencode` and `pi` profiles to `~/.config/kdi/profiles.yaml` (path overridable
  via `KDI_PROFILES_PATH`). Without `--force`, existing user entries for those
  names are preserved; `--force` overwrites them. Built-ins for `claude`/`codex`
  are left to the registry fallback and not written unless absent.
- **FR-2 (doctor):** `kdi profiles doctor [--json]` loads the merged profile set
  and, for each profile, checks that the command's leading binary resolves on
  `PATH` (via `which`-style lookup, no shell execution). Reports per profile:
  `ok`, `missing-binary`, or `parse-error`, plus the resolved binary path on
  success. Exits `1` when any profile is unhealthy; `0` when all are healthy.
- **FR-3 (pre-dispatch guard):** When `FF_REAL_HARNESS_PROFILES=true`, the
  dispatcher resolves the chosen profile's leading binary before claiming a task.
  If the binary is missing, the task is **not** claimed; the dispatcher emits a
  `profile_invalid` event with the profile name and missing binary, logs an
  operator-facing message to the board log, and skips that task for the tick
  (leaves it `ready`). When the flag is `false`, current spawn-then-fail behavior
  is unchanged.
- **FR-4 (binary resolution):** A pure helper `resolveCommandBinary(command)`
  splits the command string, expands the first token, and resolves it against
  `PATH` (plus an absolute-path shortcut). Returns `null` when not found. No
  shell invocation; safe to run per tick.
- **FR-5 (contract doc):** Add a `specs/harness-contract.md` (or
  `docs/harness-contract.md`) listing every env var `harnessEnv` actually exports
  in `src/dispatcher.ts`, grouped by the flag that gates it:
  always-on task fields (`KDI_TASK_ID`, `KDI_TASK_TITLE`, `KDI_TASK_BODY`,
  `KDI_BOARD` gated by `FF_HARNESS_CONTEXT`; `KDI_SKILLS` when `task.skills`
  is non-empty; `KDI_MODEL` when `task.model_override` is set; `KDI_CURRENT_STEP_KEY`
  when `task.current_step_key` is set), result contract (`KDI_RESULT_FILE` gated
  by `FF_RESULT_SUMMARY`), and goal mode (`KDI_GOAL_MODE`, `KDI_GOAL_MAX_TURNS`,
  `KDI_GOAL_REMAINING_TURNS`, `KDI_GOAL_TURN`, `KDI_GOAL_CONTEXT`,
  `KDI_GOAL_VERDICT_FILE` gated by `FF_GOAL_MODE`). Also list every supported
  `{{template}}` variable from `ALLOWED_TEMPLATES` in `src/profiles.ts`
  (`workdir`, `branch`, `task_id`, `agent`, `skills`, `model`, `step_key`,
  `title`, `body`, `result_file`) and the result-file convention
  (`.kdi-result.txt` in the workdir, read by `extractHarnessResult()`), plus the
  goal-verdict file convention (`.kdi-goal-verdict.json` in the workdir).
- **FR-6 (flag registration):** Register `ff_real_harness_profiles` /
  `FF_REAL_HARNESS_PROFILES` in `src/flags.ts` and `specs/feature-flags.md`,
  default `false`, status `InDev`.
- **FR-7 (no regression):** When the flag is `false`, `profiles bootstrap`,
  `profiles doctor`, and the dispatcher tick behave byte-for-byte as today
  (`bootstrap`/`doctor` are rejected with a clear flag-disabled error; dispatcher
  spawns without the pre-guard).

-------------------------------------------------------------------------------
Scope
-------------------------------------------------------------------------------
In scope:
- `kdi profiles bootstrap` and `kdi profiles doctor` subcommands (new
  `src/commands/profiles.ts`, wired into `src/index.ts`).
- `resolveCommandBinary()` pure helper in `src/profiles.ts`.
- Dispatcher pre-spawn binary guard in `src/dispatcher.ts`.
- `specs/harness-contract.md` contract doc.
- `ff_real_harness_profiles` flag registration.
- Unit tests for `resolveCommandBinary`, `bootstrap`, `doctor` (ok / missing /
  parse-error / `--force` / flag gating), and dispatcher guard (skip-claim on
  missing binary, no-op when flag off).
- User-loop smoke with temp `HOME` + temp `KDI_DB`: `bootstrap` → `doctor` →
  dispatch against a real `opencode` or `pi` binary (or a temp fake binary on
  `PATH` when the real CLI is absent) → task reaches `running` without `exit 127`.

Out of scope:
- Network installation of `opencode`/`pi` binaries (KDI only validates and
  points at them; it does not download agents).
- Auto-rewriting `claude`/`codex` built-ins.
- LLM-as-judge for goal mode (separate KDI-038 follow-up).
- Per-task profile overrides beyond existing `--assignee`.

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
- **AC-01:** `kdi profiles bootstrap` (flag on) writes `opencode` and `pi`
  entries to `KDI_PROFILES_PATH`; existing user entries for other names are
  preserved; `--force` overwrites `opencode`/`pi` entries.
- **AC-02:** `kdi profiles doctor` (flag on) prints per-profile health and
  exits `1` when any profile's binary is missing, `0` when all resolve. `--json`
  emits a stable document.
- **AC-03:** `kdi profiles doctor` flags a profile pointing at a deleted path
  (e.g. `/tmp/mock-harness`) as `missing-binary` with the offending path.
- **AC-04:** With the flag on and a stale profile assigned, `kdi dispatch --once`
  does **not** claim the task; a `profile_invalid` event is recorded and the task
  stays `ready`. The board log carries an operator-facing hint naming the
  profile and missing binary.
- **AC-05:** With the flag off, `profiles bootstrap` and `profiles doctor` are
  rejected with a clear `FF_REAL_HARNESS_PROFILES is disabled` error, and the
  dispatcher spawns without the pre-guard (current behavior unchanged).
- **AC-06:** `specs/harness-contract.md` documents every `KDI_*` env var, every
  `{{template}}` variable, and the `.kdi-result.txt` result-file convention.
- **AC-07:** `bun run lint`, `bun test` (touched tests), and `bun run build`
  pass; full suite green on the worktree.
- **AC-08:** User-loop smoke (temp `HOME`/`KDI_DB`) proves
  `bootstrap` → `doctor` → `dispatch --once` against a resolvable binary reaches
  `running` with no `exit 127`; the same loop against a missing binary leaves
  the task `ready` and emits `profile_invalid`.

-------------------------------------------------------------------------------
Risks and Mitigations
-------------------------------------------------------------------------------
- **`which` cost per tick:** binary resolution is a `stat` over `PATH` entries,
  not a shell exec; cheap. Cache not needed at expected board scale. `ponytail:`
  comment will name the upgrade path (per-profile liveness cache) if dispatch
  latency ever shows it.
- **Overwriting user customizations:** `bootstrap` without `--force` never
  overwrites existing `opencode`/`pi` entries; `--force` is explicit and logged.
- **False negatives from unusual shells:** `resolveCommandBinary` uses `PATH`
  splitting, not shell parsing, so it ignores aliases/functions. Documented as
  intentional; aliases are not safe for unattended dispatch anyway.
- **Flag-off regression:** all new code paths are gated; existing tests assert
  byte-for-byte unchanged output when the flag is off.

-------------------------------------------------------------------------------
Feature Flag
-------------------------------------------------------------------------------
- `ff_real_harness_profiles` / `FF_REAL_HARNESS_PROFILES`, default `false`,
  status `InDev`.
- **Status transitions:**
  - `Planned` → `InDev` when `profiles bootstrap`/`doctor` and the dispatcher
    guard are implemented.
  - `InDev` → `Active` when the user-loop smoke is green on a real `opencode` or
    `pi` install and the contract doc is reviewed.
- **Rollback / deactivation:** Set `FF_REAL_HARNESS_PROFILES=false` to reject
  `bootstrap`/`doctor` and disable the pre-dispatch guard.
- **Deprecation plan:** N/A (additive).