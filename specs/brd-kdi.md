BRD-KD-001: kdi — Multi-Agent Kanban Dispatch for Coding Agents
===============================================================

-------------------------------------------------------------------------------
Business Goal
-------------------------------------------------------------------------------
Enable development teams to efficiently orchestrate multiple AI coding agents
through a centralized kanban-style task board. The system allows human
operators to break down projects into discrete tasks, assign them to
specialized AI agents, track progress across the task lifecycle, and review
results without managing each agent individually.

The primary business objectives are:
1. Reduce coordination overhead when running multiple AI coding agents in parallel
2. Provide visibility into task status, assignments, and completion across all agents
3. Enable asynchronous workflows where tasks queue, execute, and report back automatically
4. Support vendor flexibility so teams can use preferred AI tools without vendor lock-in

-------------------------------------------------------------------------------
User Stories
-------------------------------------------------------------------------------
1. As a developer, I can create a kanban board for my project and add tasks
   with title, body, assignee harness profile, workspace kind, and git branch.
2. As an operator, I can mark tasks ready so the dispatcher picks them up
   and runs the assigned coding harness in the configured worktree.
3. As a reviewer, I can inspect completed tasks, request changes, or approve
   so downstream tasks unblock.
4. As an operator, I can list board status, block/unblock tasks, and view
   task output without opening any agent TUI.

-------------------------------------------------------------------------------
Functional Requirements
-------------------------------------------------------------------------------
- Board management: create, list, show, archive boards (SQLite per board).
- Task lifecycle: todo → ready → running → done / blocked / archived.
- Task metadata: title, body, assignee (harness profile name), priority, parent
  dependencies, workspace kind (dir / worktree / scratch), branch name,
  result/summary, block reason.
- CLI commands:
  - `kdi boards create <slug> --workdir <path>`
  - `kdi boards list`
  - `kdi boards show <slug>`
  - `kdi boards archive <slug>`
  - `kdi create <title> --board <slug> --assignee <profile>`
  - `kdi list --board <slug> --status <status>`
  - `kdi show <task_id>`
  - `kdi edit <task_id> --body <text>`
  - `kdi comment <task_id> <text>`
  - `kdi promote <task_id>`
  - `kdi block <task_id> --reason <text>`
  - `kdi unblock <task_id>`
  - `kdi archive <task_id>`
- Harness profiles: configurable in `~/.config/kdi/profiles.yaml`.
  Each profile defines:
  - `name`: identifier used as `--assignee` value
  - `command`: shell command template to spawn the harness
    (e.g. `opencode run --agent {{agent}} --cwd {{workdir}}`)
  - `env`: optional environment variables
  - `agent`: default agent name for this profile (if applicable)
  Built-in profile examples:
  - `opencode`: `opencode run --agent {{agent}} --cwd {{workdir}}`
  - `claude`: `claude --cwd {{workdir}}`
  - `codex`: `codex --cwd {{workdir}}`
  - `pi`: `pi run --cwd {{workdir}}`
- Dispatcher loop: poll ready tasks, resolve assignee to harness profile,
  substitute `{{workdir}}`, `{{branch}}`, `{{task_id}}`, `{{agent}}` into
  command template, spawn in isolated worktree, capture stdout/stderr/result,
  update task status.
- Dispatch worktree handoff: KDI creates a temporary per-task git worktree on
  branch `wt/<profile>/<task_id>` from the board `base_ref`, then cleans up by
  removing the worktree and deleting the local branch. The original board
  workdir is never mutated by KDI. `done` means successful harness exit plus
  result/summary capture; it does not mean code was merged, copied back, or
  preserved locally. Durable handoff is the harness/profile's job before exit:
  push `{{branch}}`, open a PR, write a patch/artifact outside `{{workdir}}`,
  or write task result text to `KDI_RESULT_FILE`.
- Profile routing: assignee string maps to a harness profile. Profile registry
  is a simple YAML file, not hard-coded to any vendor.
- Worktree isolation: per-task git worktrees with configurable base ref
  (default `origin/main`).
- Notifications: terminal delivery on task completion (later: webhook).

-------------------------------------------------------------------------------
Non-Functional Requirements
-------------------------------------------------------------------------------
- Single binary / bun script, no Python dependency.
- SQLite with WAL mode for concurrency.
- Sub-100ms CLI response for local commands.
- Dispatcher poll interval configurable (default 5s).
- Idempotent task claim (CAS-style status transition: ready → running).
- MacOS and Linux support (git worktree ops).

-------------------------------------------------------------------------------
Observability Requirements
-------------------------------------------------------------------------------
- Dispatcher tick count, claim success/failure rate, task age histogram.
- Per-agent task duration and error rate.
- Log file per board at `~/.local/share/kdi/logs/<slug>.log`.

-------------------------------------------------------------------------------
Feature Flag Requirements
-------------------------------------------------------------------------------
- `FF_ENABLE_KANBAN_DISPATCH` — gates the background dispatcher loop.
- Registered in `specs/feature-flags.md` (Phase 0 artifact).
- Defaults to `false` in all environments.

-------------------------------------------------------------------------------
Acceptance Criteria
-------------------------------------------------------------------------------
- [ ] `kdi create "backend: auth" --board myproj --assignee opencode`
      returns a task ID.
- [ ] Task promoted to ready is claimed by dispatcher within 10s.
- [ ] Harness runs in a worktree branch `wt/<profile>/<task_id>`.
- [ ] Task result is stored and visible via `show <task_id>`.
- [ ] Parent dependency blocks child until parent is `done`.
- [ ] 100 tasks created and dispatched without SQLite contention.
- [ ] `kdi --version` returns semantic version.
- [ ] Adding a new harness profile to `profiles.yaml` requires zero code changes.

-------------------------------------------------------------------------------
Risks and Mitigations
-------------------------------------------------------------------------------
- Risk: Hermes kanban schema is Python/SQLite specific; porting to TS/bun
  may miss edge cases.
  Mitigation: treat Hermes as reference, not source to copy; write fresh
  schema and tests.
- Risk: opencode agent spawn latency is high (TUI init overhead).
  Mitigation: benchmark each harness cold-start; document minimum viable
  config per harness; support `--format json` or equivalent headless flags
  where available.
- Risk: Harness CLI interfaces vary (some use `--cwd`, some use `--workdir`,
  some require interactive TTY).
  Mitigation: template substitution (`{{workdir}}`, `{{branch}}`) lets the
  operator configure the exact command per harness; no hard-coded CLI flags.
- Risk: Worktree creation differs macOS vs Linux.
  Mitigation: abstract git worktree ops behind an interface; test on both.
- Risk: SQLite WAL contention if dispatcher and CLI run concurrently.
  Mitigation: WAL mode + busy timeout + single-writer pattern.

-------------------------------------------------------------------------------
Open Questions
-------------------------------------------------------------------------------
- OQ-1: Should the dispatcher be a long-running daemon
        (`kdi dispatch`) or a cron-friendly one-shot
        (`kdi tick`)?
        → RECOMMEND: daemon mode primary; one-shot for cron fallback.
- OQ-2: Should task body support markdown or plain text only?
        → RECOMMEND: plain text in v1; markdown rendering in v2.
- OQ-3: Should profiles support remote/docker harnesses (e.g. devcontainer,
        Docker exec)?
        → RECOMMEND: v2; v1 only local shell commands.

-------------------------------------------------------------------------------
Dependencies
-------------------------------------------------------------------------------
- opencode, Claude Code, Codex CLI, pi, or any harness with a shell CLI.
- bun + TypeScript toolchain for build.
- Git repo with `origin/main` for worktree base ref.

