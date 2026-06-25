# kdi

Multi-Agent Kanban Dispatch for Coding Agents

## Quick Start

```bash
bun install
bun run dev -- --help
```

## Build

```bash
bun run build
./kdi --help
```

## Dispatch worktree handoff

Dispatch runs each harness in a temporary git worktree on branch `wt/<profile>/<task_id>`. The original board workdir is never mutated by KDI.

After the harness exits, KDI cleans up the temporary worktree and deletes the local branch. `done` means the harness exited successfully and KDI captured the result/summary; it does not mean code was merged, copied back, or preserved locally.

Harness profiles must persist durable handoff before exit: push `{{branch}}`, open a PR, write a patch or artifact outside `{{workdir}}`, or write task result text to `KDI_RESULT_FILE`.
