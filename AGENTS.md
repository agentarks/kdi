# AGENTS.md — kdi

This file governs how agents work on `kdi` (Multi-Agent Kanban Dispatch for Coding Agents).

## Project Identity

- **Name:** kdi
- **Repository:** git@github.com:agentarks/kdi.git
- **Runtime:** Bun CLI (`bun`)
- **Language:** TypeScript (ES modules)
- **Storage:** SQLite via `bun:sqlite`

## Verified Stack Versions

Pin these exact versions when adding or upgrading dependencies. Verify new versions live before documenting them here.

| Tool / Package | Version |
| --- | --- |
| bun | 1.3.10 |
| typescript | 5.9.3 |
| commander | 12.1.0 |
| yaml | 2.9.0 |
| @types/bun | 1.3.14 |

## Operating Rules

- Work from a feature branch. Open PRs for every change. Never push directly to `main`.
- Verify every package version, scaffold command, import path, and API convention live before documenting or relying on it.
- Pin exact versions in `package.json` and `AGENTS.md`; do not invent versions or version ranges.
- Every new feature is gated behind an `ff_*` flag registered in `specs/feature-flags.md` and defaults to `false` in every environment.
- Keep `STATUS.md` in sync with completed, in-progress, and pending work.
- Update this file when stack versions or conventions change.

## Agent Operating Rules

| # | Rule | Core directive |
|---|---|---|
| 1 | Think Before Coding | State goal, assumptions, trade-offs, risks before typing |
| 2 | Simplicity First | Minimum code, no speculation |
| 3 | Surgical Changes | Touch only what the task requires |
| 4 | Goal-Driven Execution | Define done, verify, report evidence |
| 5 | Use Model for Judgment | AI for classification, summarization, drafting — not deterministic runtime logic |
| 6 | Manage Context Deliberately | Split large work; summarize before reasoning degrades |
| 7 | Surface Conflicts | Don't average contradictory patterns — pick one, explain why |
| 8 | Read Before Write | Inspect caller, callee, utilities, tests, nearby patterns first |
| 9 | Tests Verify Intent | Strong tests fail when business logic is wrong |
| 10 | Checkpoint After Steps | Summarize what changed, verified, remains, risks |
| 11 | Match Codebase Conventions | Conformance beats taste |
| 12 | Fail Loud | Disclose skipped checks, uncertainty, partial verification |
| 13 | Evidence Beats Claims | Include commands, evals, file paths, screenshots, logs |

### Operating Rhythm

1. **Confirm the goal** before touching code.
2. **Check existing implementation** before assuming it's missing.
3. **Write the failing eval** before writing code.
4. **Implement** with feature flag, TDD per acceptance criterion.
5. **For new user-facing CLI features, use the `kdi-new-feature-loop` skill**: write/update tests, implement, run the feature like a real user with temp `HOME` and temp `KDI_DB`, fix code plus tests for any user-loop bug, and repeat until the CLI path works.
6. **Update STATUS.md** immediately.
7. **Report evidence** — commands, output, file paths, and user-loop smoke output when applicable.

## Code Standards

- **Runtime:** Target `ESNext`, use `bun` APIs where appropriate.
- **Imports:** Prefer `node:*` prefixes for Node built-ins (`node:os`, `node:fs`, `node:path`). Use `bun:*` for Bun APIs (`bun:sqlite`).
- **Paths:** Use the `~/*` alias to import from `src/*`.
- **Types:** `strict: true` is enabled. Avoid `any`; use explicit types. If `any` is unavoidable, leave a short note explaining why.
- **Errors:** Surface actionable error messages. Exit with non-zero codes on CLI failures.
- **Formatting:** No trailing whitespace; 2-space indentation; semicolons optional but be consistent with surrounding code.

## Concurrent Development with Git Worktrees

All work on `kdi` must happen inside a dedicated [Git worktree](https://git-scm.com/docs/git-worktree) under `.worktrees/`. Worktrees share the same object database but give each agent an isolated checkout and branch, eliminating stashing and branch switching. Use the `using-git-worktrees` skill for the exact workflow and safety checks.

### Creating a worktree

Run from the repository root:

```bash
git worktree add .worktrees/feat-<brd-id>-<slug> -b feat/<brd-id>-<slug>
cd .worktrees/feat-<brd-id>-<slug>
bun install
bun run lint
bun run test
bun run build
```

All four commands must pass before the worktree is considered ready for feature work.

### Database isolation

`kdi` stores state in SQLite (`bun:sqlite`). Because worktrees share the same working tree root by default, concurrent agents must not write to the same database file. Resolve this by making the database path configurable through the environment:

```bash
KDI_DB=.worktrees/feat-<brd-id>-<slug>/kdi.sqlite bun run test
```

The CLI resolves the database path from `KDI_DB` first, then `KDI_DB_PATH`, then falls back to the default location. Use one of those variables to keep worktree databases isolated.

Or run integration tests against an in-memory database if the test harness supports it.

### Cleanup

When a feature branch is merged or abandoned, remove the worktree and delete the local branch:

```bash
git worktree remove .worktrees/feat-<brd-id>-<slug>
git branch -D feat/<brd-id>-<slug>
```

### Known risks

- **SQLite contention:** the biggest practical risk. Always isolate the database per worktree or use an in-memory DB for tests.
- **Duplicated `node_modules`:** each worktree has its own install. Bun’s global cache reduces download overhead, but disk usage still grows with each worktree.
- **Divergent build artifacts:** `dist/`, `.bun/`, and migration state can multiply across worktrees. Keep the worktree directory ignored and clean up often.
- **Merge conflicts still happen:** worktrees isolate checkouts, not history. Coordinate branch scope the same as with normal feature branches.

## Naming and File Conventions

- CLI commands live in `src/commands/<domain>.ts` and are wired into `src/index.ts`.
- Data models live in `src/models/<entity>.ts`.
- Database schema and migrations live in `src/db.ts`.
- Pure utilities and cross-cutting concerns live at `src/<concern>.ts` (e.g. `src/profiles.ts`, `src/worktree.ts`).
- Tests mirror source structure under `tests/` and use the `*.test.ts` suffix.

## Verification Expectations

Before claiming work is complete, run:

```bash
bun install
bun run lint
bun run test
bun run build
```

All commands must pass with no errors. If a test is flaky or environment-specific, document it in `STATUS.md` under Tech Debt before merging.

## Never-Do Guidance

- Do not commit secrets, API keys, or `.env` files.
- Do not push directly to `main`.
- Do not invent unverified package versions or import paths.
- Do not add new features without registering the corresponding feature flag.
- Do not leave `TBD` in `specs/feature-flags.md` or `STATUS.md`.
- Do not add source code to `backend/` or `frontend/`; this project is a single Bun CLI binary.

## PR Workflow

1. Create a feature branch from `main`: `feat/<brd-id>-<feature-slug>`.
2. Make focused commits with clear messages.
3. Run the verification commands above.
4. Update `STATUS.md` and `AGENTS.md` if conventions or versions changed.
5. Open a PR and request review. PR description must include: BRD link, eval evidence, flag status, migration notes.
6. Merge only after checks pass and review is approved.
