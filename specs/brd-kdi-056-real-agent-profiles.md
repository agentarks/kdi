# BRD-KDI-056: Real Agent Profiles

-------------------------------------------------------------------------------
Business Goal
-------------------------------------------------------------------------------
Make kdi's harness launcher refuse to silently dispatch a task into a broken or
stale user profile. When a profile points at a missing binary, a stale
`/tmp/mock-harness`, or an unknown agent, dispatch must fail *before* a task is
claimed/spawned with an actionable operator-facing error, and the operator must
have a supported way to bootstrap or repair real `pi` and `opencode` profiles.

-------------------------------------------------------------------------------
Problem Statement
-------------------------------------------------------------------------------
KDI profiles live in `~/.config/kdi/profiles.yaml` (or `$KDI_PROFILES_PATH`) and
the dispatcher resolves a profile per task via `getProfile(task.assignee ??
"opencode")` in `src/dispatcher.ts`. Today the only pre-dispatch check is that
the profile *name* is known: an unknown name fails fast with "Unknown profile"
and counts as a spawn failure. A known profile whose `command` references a
binary that is not on `PATH`, or points at a stale stub like `/tmp/mock-harness`,
is *not* validated before the task transition `ready -> running` and worktree
creation. The harness then exits `127` (command not found) or fails opaquely
after the task is already claimed and a worktree has been created, leaving the
operator to debug exit codes with no kdi-side guidance.

A local smoke run of `scripts/e2e-stub-profile.sh` surfaced this: user-level
profiles can carry a stale `/tmp/mock-harness` reference and block dispatch
with exit 127 and no clear operator message. The `$KDI_TASK_*` and
`$KDI_RESULT_FILE` env-var contract that kdi hands to harnesses is also
under-documented for harness authors.

-------------------------------------------------------------------------------
User-Visible Decision Options
-------------------------------------------------------------------------------
1. **Document-only + pre-dispatch binary check:** add a `kdi profile doctor`
   that reports (and optionally writes) real `pi`/`opencode` profiles, and a
   pre-dispatch `command -v <binary>` / binary-runnability probe that blocks the
   claim with an actionable error when it fails. No automatic install of the
   external binary itself.
2. **Auto-install the harness binary:** have kdi download/install `pi` /
   `opencode`. Highest automation, highest surprise and trust-boundary risk; kdi
   is a dispatcher, not a package manager.
3. **No validation, doc-only contract:** keep the current behavior and only
   document `$KDI_TASK_*` / `$KDI_RESULT_FILE`. Rejected: it leaves exit 127 as
   the operator's first signal.

-------------------------------------------------------------------------------
Chosen Recommendation
-------------------------------------------------------------------------------
Choose option 1. kdi validates that the configured harness binary exists on
`PATH` and is executable, and that the profile command parses, *before*
claiming a task or creating a worktree. It exposes `kdi profile doctor` and
`kdi profile bootstrap` to inspect and materialize real `pi` and `opencode`
profiles in `~/.config/kdi/profiles.yaml`. kdi never downloads or installs the
external harness binaries; it tells the operator how to install them when they
are missing. The `$KDI_TASK_*` and `$KDI_RESULT_FILE` env-var contract is
documented in this BRD and enforced by a contract assertion in the dispatcher.

-------------------------------------------------------------------------------
Current Behavior vs Desired Behavior
-------------------------------------------------------------------------------
| Aspect | Current | Desired |
|---|---|---|
| Unknown profile name | Fails fast with "Unknown profile", counts as a spawn failure | Unchanged |
| Known profile, missing binary | Task claimed `ready -> running`, worktree created, harness exits 127, opaque failure | Pre-dispatch binary check; claim/worktree never happens; actionable error to operator + task blocked/requeued with clear reason |
| Known profile, stale `/tmp/mock-harness` | Same as missing binary: opaque exit 127 after claim | Detected by binary probe; same actionable error path |
| Bootstrap real `pi` profiles | Manual YAML editing | `kdi profile bootstrap pi` writes a known-good `pi` profile entry if absent |
| Bootstrap real `opencode` profiles | Manual YAML editing | `kdi profile bootstrap opencode` writes a known-good `opencode` profile entry if absent |
| Profile inspection | Operator reads YAML by hand | `kdi profile doctor` lists profiles, binary resolution, and runnability verdict |
| `$KDI_TASK_*` / `$KDI_RESULT_FILE` contract | Implemented in code (`src/dispatcher.ts`), undocumented for harness authors | Documented in this BRD; dispatcher asserts the documented set is exported when the corresponding flags are on |
| Operator guidance on validation failure | None beyond recorded failure reason | Failure message names the profile, the missing binary, and the `kdi profile doctor` / `kdi profile bootstrap <profile>` remediation hint |

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------
- Introduce a pure `validateProfileHarness(profile)` helper (in `src/profiles.ts`)
  that resolves the first bare binary token of `profile.command` (after template
  substitution with placeholder values) against `PATH` and returns a structured
  verdict: `{ ok: boolean, binary: string, resolvedPath?: string, reason?: string }`.
- The dispatcher, *before* the `ready -> running` claim and before worktree
  creation, runs `validateProfileHarness` on the resolved profile when
  `FF_REAL_AGENT_PROFILES=true`. On a failure it does NOT claim the task; it
  records a `harness_invalid` task event with the verdict, writes an
  actionable operator message (profile name, missing binary, remediation hint)
  to the board log and stderr, and blocks the task with reason
  `"Harness binary invalid: <binary> (<reason>)"`.
- Add a `kdi profile doctor` command that lists every loaded profile (name,
  agent, command, resolved binary path or `NOT FOUND`, runnability verdict) and
  exits non-zero if any profile is invalid. Support `--json` for a stable
  machine-readable document.
- Add a `kdi profile bootstrap <name>` command that, for `name in {pi,
  opencode}`, writes the canonical built-in profile entry into
  `~/.config/kdi/profiles.yaml` (or `$KDI_PROFILES_PATH`) if no profile with
  that name exists, and reports the entry plus the binary resolution verdict.
  Rejecting an already-present name with a clear error (non-destructive).
- Export a `PROFILES_PATH` resolution shared by `profiles.ts` so `profile
  doctor` / `bootstrap` honor `KDI_PROFILES_PATH` then `~/.config/kdi/profiles.yaml`
  identically to `ensureProfiles` / `loadProfiles`.
- When the validation fails because the binary is missing, the operator message
  must include a one-line install hint: `pi` -> `bun add -g @pi/agent` (or the
  documented install command), `opencode` -> its documented install command;
  unknown agents get a generic "install the binary and re-run kdi profile
  doctor" hint.
- Document and enforce the harness env-var contract. The dispatcher must
  export this set to the harness process when the corresponding flags are on,
  and `kdi profile doctor` must be able to print the contract for harness
  authors:
  - `KDI_TASK_ID` (always when `FF_HARNESS_CONTEXT=true`)
  - `KDI_TASK_TITLE` (when `FF_HARNESS_CONTEXT=true`)
  - `KDI_TASK_BODY` (when `FF_HARNESS_CONTEXT=true`)
  - `KDI_BOARD` (when `FF_HARNESS_CONTEXT=true`)
  - `KDI_RESULT_FILE` (when `FF_RESULT_SUMMARY=true`; path inside the worktree
    where the harness should write a clean result)
  - `KDI_SKILLS` (when set and `FF_SKILLS_ARRAY=true`)
  - `KDI_MODEL` (when set and `FF_MODEL_OVERRIDE=true`)
  - `KDI_CURRENT_STEP_KEY` (when set and `FF_WORKFLOW_TEMPLATES=true`)
  - `KDI_GOAL_MODE`, `KDI_GOAL_MAX_TURNS`, `KDI_GOAL_REMAINING_TURNS`,
    `KDI_GOAL_TURN`, `KDI_GOAL_CONTEXT`, `KDI_GOAL_VERDICT_FILE` (when
    `FF_GOAL_MODE=true` and the task is goal-mode)
- The exact env var name strings kdi reads/writes are `KDI_TASK_ID`,
  `KDI_TASK_TITLE`, `KDI_TASK_BODY`, `KDI_BOARD`, `KDI_RESULT_FILE`,
  `KDI_SKILLS`, `KDI_MODEL`, `KDI_CURRENT_STEP_KEY`, `KDI_GOAL_MODE`,
  `KDI_GOAL_MAX_TURNS`, `KDI_GOAL_REMAINING_TURNS`, `KDI_GOAL_TURN`,
  `KDI_GOAL_CONTEXT`, `KDI_GOAL_VERDICT_FILE`. No other `KDI_*` env vars are
  part of this contract.

> **Assumption (Fail-Loud):** the harness env-var contract documented here
> reflects the *already-shipped* dispatcher behavior in `src/dispatcher.ts`
> (lines 590–612). KDI-056 does not change that contract; it adds
> `kdi profile doctor` printing of the contract and a regression
> contract-assertion test in Verification Notes. AC numbering follows the
> labelled imperative `AC-XX:` convention used by BRD-006/008/009, not the
> unlabelled-sentence convention of BRD-KDI-055; the section *structure*
> mirrors BRD-KDI-055 exactly.
- When `FF_REAL_AGENT_PROFILES=false`, no pre-dispatch validation runs and the
  dispatcher behaves exactly as today (claim first, surface exit 127 as a
  normal harness failure).

-------------------------------------------------------------------------------
Feature Flag Requirements
-------------------------------------------------------------------------------
Register and implement behind `ff_real_agent_profiles` /
`FF_REAL_AGENT_PROFILES` (upper-snake env form), default `false`. The flag MUST
be registered in `specs/feature-flags.md` and as the `FF_REAL_AGENT_PROFILES`
constant in `src/flags.ts` before implementation begins.

When `FF_REAL_AGENT_PROFILES=false`:
- The dispatcher performs no pre-dispatch harness validation.
- `kdi profile doctor` and `kdi profile bootstrap <name>` are rejected with a
  clear flag-gating error and exit non-zero.

When `FF_REAL_AGENT_PROFILES=true`:
- Pre-dispatch `validateProfileHarness` runs before claim/worktree creation.
- `kdi profile doctor` and `kdi profile bootstrap <name>` are available.

-------------------------------------------------------------------------------
Non-Goals
-------------------------------------------------------------------------------
- Auto-downloading or auto-installing the `pi`, `opencode`, `claude`, or
  `codex` binaries. kdi is a dispatcher, not a package manager.
- Validating the agent *semantics* of a profile (e.g. that `opencode` actually
  accepts `--agent <name>`); only that the binary exists and is executable.
- New task status values. Validation failures reuse the existing `blocked`
  status with a descriptive `block_reason`.
- Changing the `~/.config/kdi/profiles.yaml` schema, the `Profile` interface, or
  `ALLOWED_TEMPLATES`.
- Validating non-builtin / custom-named profiles beyond the shared binary
  probe; the probe applies to any profile, but install hints are only defined
  for `pi` and `opencode`.
- Authenticating the operator or managing API keys for the harness binaries.
- SvelteKit UI for the profile doctor / bootstrap commands.

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
All acceptance criteria assume `FF_REAL_AGENT_PROFILES=true` unless noted.

- [ ] AC-01: `kdi profile doctor` exits `0` and lists every loaded profile
      with its resolved binary path when all profiles resolve.
- [ ] AC-02: `kdi profile doctor` exits non-zero and prints a `NOT FOUND`
      verdict line for a profile whose binary is missing from `PATH`.
- [ ] AC-03: `kdi profile doctor --json` emits a stable JSON document with an
      array of `{ name, agent, command, binary, resolved_path, ok, reason? }`
      objects.
- [ ] AC-04: `kdi profile doctor` prints the documented `$KDI_TASK_*` and
      `$KDI_RESULT_FILE` env-var contract section, gated by the same flags
      that gate each variable's export.
- [ ] AC-05: `kdi profile bootstrap pi` writes a `pi` profile entry to
      `~/.config/kdi/profiles.yaml` when none exists and prints the written
      entry plus its binary verdict.
- [ ] AC-06: `kdi profile bootstrap opencode` writes an `opencode` profile
      entry to `~/.config/kdi/profiles.yaml` when none exists and prints the
      written entry plus its binary verdict.
- [ ] AC-07: `kdi profile bootstrap pi` rejects with a clear non-destructive
      error when a `pi` profile already exists; the existing file is not
      modified.
- [ ] AC-08: `kdi profile bootstrap unknown` rejects unknown profile names
      with a clear error listing supported names (`pi`, `opencode`).
- [ ] AC-09: `kdi profile doctor` and `kdi profile bootstrap <name>` are
      rejected with a clear flag-gating error and non-zero exit when
      `FF_REAL_AGENT_PROFILES=false`.
- [ ] AC-10: A task assigned to a profile whose binary is missing is NOT
      transitioned `ready -> running` and no worktree is created for it when
      `FF_REAL_AGENT_PROFILES=true`; the task is blocked with reason
      `Harness binary invalid: <binary> (<reason>)`.
- [ ] AC-11: A `harness_invalid` task event is recorded with payload
      `{ profile, binary, reason }` when validation fails.
- [ ] AC-12: The operator-facing validation-failure message names the
      profile, the missing binary, and includes the `kdi profile doctor` /
      `kdi profile bootstrap <profile>` remediation hint.
- [ ] AC-13: With a stale profile whose `command` references
      `/tmp/mock-harness`, `kdi profile doctor` reports `NOT FOUND` and a
      dispatch attempt against a task using that profile blocks the task
      (AC-10/AC-11) instead of exiting 127 after claim.
- [ ] AC-14: When `FF_REAL_AGENT_PROFILES=false`, a task assigned to a
      profile whose binary is missing follows the existing behavior: it is
      claimed, the harness exits 127, and the run records a normal harness
      failure (no `harness_invalid` event, no pre-claim block).
- [ ] AC-15: `KDI_PROFILES_PATH` overrides the profiles file path for `kdi
      profile doctor` and `kdi profile bootstrap <name>`, mirroring
      `ensureProfiles` / `loadProfiles`.
- [ ] AC-16: `bun run lint`, `bun test`, and `bun run build` pass with the new
      profiles/commands and tests.

-------------------------------------------------------------------------------
Migration / Rollout
-------------------------------------------------------------------------------
- Register `ff_real_agent_profiles` / `FF_REAL_AGENT_PROFILES` in
  `specs/feature-flags.md` (status `Planned`, default `false`, since `KDI-056`)
  and add the `FF_REAL_AGENT_PROFILES` constant to `src/flags.ts` *before* any
  implementation commits.
- `kdi profile doctor` and `kdi profile bootstrap <name>` are safe to run
  repeatedly and are read-only / non-destructive by default; they never delete
  or overwrite an existing profile entry. They are gated entirely behind the
  flag and error cleanly when the flag is off.
- The pre-dispatch validation is additive and only runs when the flag is on;
  default behavior is unchanged for all existing users.
- Operators with stale `profiles.yaml` entries (e.g. `/tmp/mock-harness`) will
  see tasks that previously failed with exit 127 instead block with an
  actionable reason. Unblocking after a `kdi profile doctor`-guided repair is
  the supported recovery path.
- Update `STATUS.md` KDI-056 section to reflect BRD completion and pending
  implementation items.

-------------------------------------------------------------------------------
Verification Notes
-------------------------------------------------------------------------------
Future implementation should prove this with isolated `HOME` / `KDI_DB` and the
existing `scripts/e2e-stub-profile.sh`-style harness:

- `kdi profile doctor` against built-in profiles with `pi`/`opencode` present
  prints resolved paths and exits 0.
- `kdi profile doctor` against a temp `HOME` whose `PATH` hides `pi` reports
  `NOT FOUND` for `pi` and exits non-zero.
- `kdi profile bootstrap pi` followed by `kdi profile doctor` shows the
  bootstrapped `pi` entry.
- A dispatch against a profile whose binary is `/tmp/mock-harness` (missing)
  with `FF_REAL_AGENT_PROFILES=true` blocks the task and records a
  `harness_invalid` event; no worktree is created; no exit-127 harness run
  appears in `kdi runs <id>`.
- The same dispatch with `FF_REAL_AGENT_PROFILES=false` still claims the task,
  spawns, exits 127, and records a normal harness failure run (regression guard).
- `kdi profile doctor --json` parses to the documented schema.
- A contract assertion test confirms the dispatcher exports the documented
  `KDI_TASK_*` / `KDI_RESULT_FILE` set under the documented flags.

-------------------------------------------------------------------------------
Open Questions
-------------------------------------------------------------------------------
- Should `kdi profile doctor` also probe the worktree base ref / `git` binary
  availability, or is that out of scope for KDI-056 (which targets harness
  binaries only)?
- Should `kdi profile bootstrap` support `claude` and `codex` in addition to
  `pi` and `opencode`, or wait for explicit operator demand?
- Should a validation-failed task be `blocked` (current recommendation) or
  `requeued` with a short backoff so a transient `PATH` fix can recover it
  without an explicit `kdi unblock`?
- Should the install hint text be sourced from the profile entry itself (a
  new optional `install_hint` field) or hard-coded per known agent in a
  registry? Preferred: keep the `Profile` interface unchanged for KDI-056
  and hard-code hints for `pi` / `opencode`; revisit if custom profiles need
  hints.

-------------------------------------------------------------------------------
Future Option
-------------------------------------------------------------------------------
If operators later want kdi to actually install the harness binaries (option 2
above), add a separate explicit `kdi profile install <name>` command that runs a
documented, operator-confirmed install. It must never run silently as a side
effect of `bootstrap` or `doctor`, and must require deliberate operator action.
It is not part of KDI-056.