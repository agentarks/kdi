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
6. **Update STATUS.md** immediately.
7. **Report evidence** — commands, output, file paths.

## Code Standards

- **Runtime:** Target `ESNext`, use `bun` APIs where appropriate.
- **Imports:** Prefer `node:*` prefixes for Node built-ins (`node:os`, `node:fs`, `node:path`). Use `bun:*` for Bun APIs (`bun:sqlite`).
- **Paths:** Use the `~/*` alias to import from `src/*`.
- **Types:** `strict: true` is enabled. Avoid `any`; use explicit types. If `any` is unavoidable, leave a short note explaining why.
- **Errors:** Surface actionable error messages. Exit with non-zero codes on CLI failures.
- **Formatting:** No trailing whitespace; 2-space indentation; semicolons optional but be consistent with surrounding code.

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
