# Specification: KDI-UI-002 — Board Management UI

> Parent backlog: `specs/sveltekit-ui-backlog.md` → `KDI-UI-002: Board management UI`.
> Scope of this document: the **full** KDI-UI-002 item — a browser operator UI for
> the complete board lifecycle. This is a **spec-writing task**, not an
> implementation. All behavior contracts are validated against the live CLI/model
> source (`src/commands/boards.ts`, `src/models/board.ts`, `src/resolveBoard.ts`,
> `src/flags.ts`, `specs/feature-flags.md`).

---

## 1. Business Goal

Give operators a browser UI for the full board management lifecycle that `kdi
boards` already exposes on the CLI: **list, show, create, edit, switch, archive,
hard-delete, set-default-workdir, rename (display name), and rename-slug**. The
UI must not introduce any behavior the CLI does not already support, and must
gate every mutation behind the same feature flags the CLI uses. The browser UI
is the operator's landing page after `kdi init` and the home of every later
KDI-UI screen.

## 2. Problem Statement

`kdi boards` is feature-complete and flag-stable on the CLI, but there is no UI.
The SvelteKit UI backlog gates this screen at P1 (KDI-UI-002), but its P0
prerequisites are not built: there is no SvelteKit app, no server-side data
bridge, and `FF_SVELTEKIT_FRONTEND` is only `Planned` in `specs/feature-flags.md`
(it is not yet present in `src/flags.ts`). A browser UI for board management
therefore does not exist and cannot exist until the shell and a model-calling
server bridge do. Additionally, AGENTS.md's Never-Do section forbids adding
source under `backend/` or `frontend/` ("this project is a single Bun CLI
binary"); the UI's proposed home is `apps/web/`, which requires an AGENTS.md
amendment — a KDI-UI-000 concern called out here so board management is not
blamed for the scaffold.

This document specifies the contract KDI-UI-002 must meet once the prerequisites
land, so implementation can proceed without re-deriving the CLI semantics and
reviewers can verify the parent acceptance (the union of
`create / list / show / edit / switch / archive / rm / set-default-workdir /
rename`) against a single source of truth.

## 3. Prerequisites (hard blockers)

- **KDI-UI-000 — SvelteKit app shell.** `apps/web` SvelteKit app scaffolded;
  `FF_SVELTEKIT_FRONTEND` registered in `src/flags.ts` (InDev, default `false`)
  and `VITE_FF_SVELTEKIT_FRONTEND` available to the browser; AGENTS.md amended to
  permit `apps/web/`; CLI `bun run build` and SvelteKit build/dev work with
  isolated `KDI_DB`.
- **KDI-UI-001 — server-side data bridge.** SvelteKit server routes/load actions
  can call existing KDI model code (`src/models/*`) and return UI-shaped JSON;
  SQLite access stays server-side only. One smoke test can create a temp
  board/task through the bridge and read it back. (A draft for this bridge exists
  at `specs/sveltekit-ui/KDI-UI-001-server-data-bridge.md`.)

KDI-UI-002 adds **only** SvelteKit routes/components and the narrow server
loaders/actions its screens need. It must not modify `src/models/*`,
`src/commands/*`, `src/resolveBoard.ts`, `src/db.ts`, or `src/flags.ts` beyond
imports. If a needed JSON shape is missing, the gap is raised against KDI-UI-001,
not patched here.

## 4. Decision Options

1. **Prerequisites first; KDI-UI-002 as a set of consuming screens.** Build
   KDI-UI-000 and KDI-UI-001 first, then add board-management UI strictly on top
   of existing model functions. **Chosen.** Cleanest dependency graph; no slice
   bundles the shell; every mutation maps to one existing model call.
2. **Bundle a minimal shell into this item.** Land the SvelteKit shell + board
   bridge + board UI in one PR. Faster to a visible screen, but conflates three
   backlog items and risks rework when KDI-UI-000 is done "for real". Rejected
   (violates surgical-slice rule, AGENTS.md #3).
3. **Read-only list now, full management later.** Ship only the list without
   mutations. Smallest, but fails the parent acceptance (which requires
   `create`/`edit`/`switch`/`archive`/`rm`/`set-default-workdir`/`rename`).

## 5. Current vs Desired Behavior

| Aspect | Current (CLI) | Desired (UI) |
|---|---|---|
| List | `kdi boards list [--all]` → `listBoards(includeArchived)` | Board list screen; current badge; archived toggle; metadata; workdir; base ref; per-status counts |
| Show | `kdi boards show [slug]` → `resolveBoard()` → `showBoard(slug, true)`; metadata display gated `FF_BOARD_METADATA`; default workdir gated `FF_DEFAULT_WORKDIR` | Detail route `boards/[slug]`; bare `boards` resolves current → `"default"`; same flag-gated display |
| Create | `kdi boards create <slug> --workdir --base-ref --name --icon --color --description --switch` | Create form; metadata gated `FF_BOARD_METADATA`; switch gated `FF_BOARD_CREATE_SWITCH`; on success `writeCurrentBoard` if switch |
| Edit | `kdi boards edit <slug> --name --icon --color --description` (gated `FF_BOARD_METADATA`) | Edit form calling `updateBoardMetadata` |
| Set default workdir | `kdi boards set-default-workdir <slug> [path]` (empty clears), gated `FF_DEFAULT_WORKDIR` | Edit field; empty clears |
| Switch | `kdi boards switch <slug>` (gated `FF_BOARD_SWITCH`) → `showBoard(slug, true)` then `writeCurrentBoard` | "Make current" action; allows archived boards |
| Rename (name) | `kdi boards rename <slug> <name>` (gated `FF_BOARD_RENAME_HERMES`) → `updateBoardMetadata({name})` | Rename dialog; slug immutable shown read-only |
| Rename (slug) | `kdi boards rename-slug <old> <new>` (gated `FF_BOARD_RENAME`) → `renameBoardSlug`; updates `current` if matched | Separate confirm dialog; warns data dir + `current` may move |
| Archive | `kdi boards archive <slug>` → `archiveBoard` (no flag gate) | Archive action; confirm naming slug |
| Hard delete | `kdi boards rm <slug> --delete` (gated `FF_BOARD_RM_DELETE`) → `removeBoard(slug, true)` cascade + rmSync dir | Delete action visible only when flag on; typed-slug confirm |
| Restoration | No `unarchive`; archived boards visible only via `--all` | Same — no restore affordance |
| Flag gating | CLI per-command flags | Whole UI behind `FF_SVELTEKIT_FRONTEND`; per-action flags enable/disable/hide controls |

## 6. Functional Requirements

### 6.1 List screen

- **FR-1** A read-only `boards` route provides a `+page.server.ts` load function
  calling `listBoards(includeArchived)` and returning
  `{ boards, includeArchived, currentSlug }` as UI-shaped JSON. No mutation
  endpoints on this route.
- **FR-2** Each board row renders, from the `Board` interface: `name` (fallback
  to `slug` when null/empty), `slug`, `icon` (when set), `color` (swatch when
  set), `description` (truncated with full text in a title attribute), `workdir`,
  and `base_ref`.
- **FR-3** The row whose `slug` equals `readCurrentBoard()` gets a visible
  "Current" badge. When the current file is missing or names a missing board, no
  row is badged and no error is thrown.
- **FR-4** For each board the loader calls `getBoardStats(slug)` and attaches the
  8 `status_counts` buckets (`triage`, `todo`, `scheduled`, `ready`, `running`,
  `done`, `blocked`, `review`). `assignee_counts` and `oldest_ready_age_seconds`
  are **not** rendered here (they belong to KDI-UI-009 stats/diagnostics).
- **FR-5** An "include archived" toggle flips `includeArchived` between `false`
  and `true` and re-loads the list; archived boards are visually distinguished
  (dimmed + "archived" tag). Defaults to `false`, matching `listBoards(false)`.
- **FR-6** When `listBoards` returns `[]`, the screen shows a clear empty state
  pointing to `kdi init` / `kdi boards create`. No create button in the list
  itself is required, but a link to the create route is acceptable.
- **FR-7** A loader failure (e.g. DB unavailable) renders an inline error with
  the model error text; never silently shows an empty table for a failure.

### 6.2 Show / detail screen

- **FR-8** A read-only `boards/[slug]` route loads the board via
  `showBoard(slug, true)` and renders `slug`, `name`, `workdir`, `base_ref`,
  `created_at`, and all 9 `taskCounts` buckets (incl. `archived`). An archived
  board renders with an "(archived)" tag — it is **not** a 404. A missing slug
  renders a 404 page / inline `Board "..." not found.` error.
- **FR-9** `icon`/`color`/`description` render only when `FF_BOARD_METADATA` is
  on; `default_workdir` renders only when `FF_DEFAULT_WORKDIR` is on and
  non-null. When a flag is off, those fields are omitted (not shown as empty) —
  matching CLI `show`.
- **FR-10** The `/boards` route is the board list; the detail view lives at
  `/boards/[slug]`. The list highlights the board whose slug equals
  `readCurrentBoard()` with a "Current" badge. When the current file is missing
  or names a missing board, no row is badged and no error is thrown. (The
  browser has no `--board` / `KDI_BOARD` surface, so this is the UI subset of
  `resolveBoard`'s chain; documented as intentional, not a divergence claim.)

### 6.3 Create form

- **FR-11** A `boards/new` route provides a form and a `+page.server.ts` action
  calling `createBoard(slug, workdir, baseRef, metadata)`. Required: `slug`,
  `workdir`. Optional: `baseRef` (default `"origin/main"`), `name`, `icon`,
  `color`, `description`, and a `switch` checkbox.
- **FR-12** Metadata fields are enabled only when `FF_BOARD_METADATA` is on; when
  off they are disabled (visible-but-greyed) with a flag-name tooltip. A
  submitted metadata value while the flag is off is rejected server-side with
  `"Board metadata feature is not enabled."` (defence in depth).
- **FR-13** The `switch` checkbox is enabled only when `FF_BOARD_CREATE_SWITCH`
  is on. On a successful create with `switch` checked, the action calls
  `writeCurrentBoard(slug)`. A submitted `switch=true` while the flag is off is
  rejected with `"Board create --switch feature is not enabled."`.
- **FR-14** Invalid slugs are rejected with the `assertValidBoardSlug` text;
  duplicate slugs with `Board with slug "..." already exists`; empty-string
  metadata with `validateMetadataField` text (`"Name cannot be empty."` etc.). In
  every error case the form stays mounted with values preserved.
- **FR-15** On success the action redirects to the read-only `boards` route,
  where the new board appears (with the current badge if `switch` was set), plus
  a short success message via SvelteKit form-action flash.

### 6.4 Edit (metadata + default workdir)

- **FR-16** A `boards/[slug]/edit` route loads the board via `showBoard(slug)`
  (404 if not found or archived) and provides two form actions:
  - a metadata action calling
    `updateBoardMetadata(slug, { name, icon, color, description })`;
  - a default-workdir action calling `setDefaultWorkdir(slug, path | null)`.
  Splitting into two actions keeps each a single atomic model call matching the
  two distinct CLI commands.
- **FR-17** The metadata edit action is gated by `FF_BOARD_METADATA`. At least
  one metadata field is required (model throws
  `"At least one metadata field is required."` otherwise). Empty-string fields
  are rejected by `validateMetadataField`. Not-found/archived surfaces
  `"Board \"...\" not found or is archived."`.
- **FR-18** The default-workdir action is gated by `FF_DEFAULT_WORKDIR`. Empty
  submission clears the default workdir (`setDefaultWorkdir(slug, null)`); a
  non-empty value must trim to non-empty or be rejected with
  `"Default workdir cannot be empty. Omit the path to clear it."`.
- **FR-19** Each form submits to exactly one model call; on failure no partial
  write occurs (model functions are atomic single statements). The UI re-renders
  the form with the model error inline and values preserved; never shows success
  for a failed write.

### 6.5 Switch

- **FR-20** A "Make current" control on board rows and the detail route submits a
  server action gated by `FF_BOARD_SWITCH`. The action calls `showBoard(slug,
  true)`; if null, rejects with `Board "..." not found.` and does not touch the
  current file. On success calls `writeCurrentBoard(slug)` (which re-validates
  via `assertValidBoardSlug`). Switching to an archived board is allowed
  (matches CLI, which uses `showBoard(slug, true)`). After switch the list badge
  moves.
- **FR-21** With `FF_BOARD_SWITCH` off, "Make current" is disabled with a
  `FF_BOARD_SWITCH` tooltip; a submitted switch is rejected server-side with
  `"Board switch feature is not enabled."`.

### 6.6 Rename (display name + slug)

- **FR-22** A "Rename" dialog collects a new `name` and submits a server action
  gated by `FF_BOARD_RENAME_HERMES` calling `updateBoardMetadata(slug, { name })`.
  The slug is shown read-only (display-name rename does not change it).
  Empty-string `name` is rejected with `"Name cannot be empty."`. With the flag
  off, submitted rename is rejected with
  `"Board rename (Hermes semantics) feature is not enabled."`.
- **FR-23** A separate "Rename slug" dialog (stronger affordance — it moves the
  data directory and may rewrite `current`) collects a new slug and submits a
  server action gated by `FF_BOARD_RENAME` calling `renameBoardSlug(old, new)`.
  The new slug is validated with `assertValidBoardSlug`; same-slug
  (`"New slug must differ from the current slug."`), conflict
  (`Board with slug "..." already exists.`), not-found/archived
  (`"Board \"...\" not found or is archived."`) errors surface verbatim. The
  dialog summarizes that the board data directory and current file may be
  moved/rewritten.
- **FR-24** On successful slug rename, if `readCurrentBoard()` was the old slug,
  the current-board file is rewritten to the new slug — matching CLI
  `rename-slug`. The list/detail then navigates to the new slug. With the flag
  off, submitted slug rename is rejected with
  `"Board rename feature is not enabled."`.

### 6.7 Archive

- **FR-25** An "Archive" control on each non-archived board row opens a confirm
  dialog naming the slug and display name; confirming submits a server action
  calling `archiveBoard(slug)`. Archive is **not** flag-gated at the model/CLI
  layer, so this slice imposes no extra flag beyond `FF_SVELTEKIT_FRONTEND`. No
  typed input is required (archive is soft one-way).
- **FR-26** If `archiveBoard` throws `Board "..." not found or already archived`
  (race), the error is shown inline and the list re-renders to truth. No success
  on a failed/already-archived write.

### 6.8 Hard-delete

- **FR-27** A "Delete permanently" control is rendered on a row **only** when
  `FF_BOARD_RM_DELETE` and `FF_SVELTEKIT_FRONTEND` are both on. When
  `FF_BOARD_RM_DELETE` is off, the control is **absent** (not greyed) — hard
  delete is irreversible and the UI must not dangle a path to it.
- **FR-28** Confirming opens a dialog that: names slug + display name; enumerates
  the permanent cascade (all tasks, runs, events, attachments, comments,
  dependencies, workflow templates, plus the on-disk board data directory);
  requires the operator to **type the exact slug**; keeps the confirm button
  disabled until the typed value equals the slug.
- **FR-29** The server action re-checks `FF_BOARD_RM_DELETE` and re-validates the
  confirmed slug; if either fails it rejects with the CLI text
  (`Board hard-delete is not enabled...` or `Board "..." not found`) and performs
  no deletion. On success it calls `removeBoard(slug, true)` exactly once (the
  model's hard path runs one DB transaction + `rmSync` of the board data dir).
  Errors surface verbatim; no UI state is committed to "deleted" on failure.

### 6.9 Cross-cutting

- **FR-30** Archiving or deleting the **current** board does not modify
  `~/.local/share/kdi/current` — matches CLI. A follow-up slice may decide to
  clear `current` then; out of scope here. Same for archive/delete of any board.
- **FR-31** The whole UI renders only when `FF_SVELTEKIT_FRONTEND` is enabled
  (server-side gate; otherwise 404/"UI disabled"). Every per-action flag is
  re-checked on the server on submit; client-side enable/disable is UX only.
- **FR-32** No server endpoint accepts a mutation without its confirm/flag
  contract satisfied: hard-delete without a matching typed slug is rejected;
  switch/rename without their flags are rejected; archive without a confirmed
  click is rejected. There is no "quick delete" or unprotected endpoint.
- **FR-33** KDI-UI-002 adds only SvelteKit routes and components that import
  existing model/resolve functions: `listBoards`, `showBoard`, `getBoardStats`,
  `createBoard`, `updateBoardMetadata`, `setDefaultWorkdir`,
  `readCurrentBoard`, `writeCurrentBoard`, `renameBoardSlug`, `archiveBoard`,
  `removeBoard`, `assertValidBoardSlug`. It must not modify `src/models/*`,
  `src/commands/*`, `src/resolveBoard.ts`, `src/db.ts`, or `src/flags.ts`.

## 7. Scope

In scope:
- Read-only `boards` list route (+ archived toggle, current badge, counts).
- Read-only `boards/[slug]` detail route (covers `show`).
- `boards/new` create route.
- `boards/[slug]/edit` route (metadata + default-workdir).
- "Make current" switch action on list/detail rows.
- Display-name rename dialog/action.
- Slug-rename dialog/action (incl. current-file rewrite).
- Archive action + confirm dialog.
- Hard-delete action (flag-gated) + typed-slug confirm dialog.
- Server-side + client-side flag gating for `FF_SVELTEKIT_FRONTEND` and the
  per-action flags listed in §10.

Out of scope (explicitly):
- SvelteKit scaffolding / `apps/web` / AGENTS.md amendment / `FF_SVELTEKIT_FRONTEND`
  registration in `src/flags.ts` (KDI-UI-000).
- General server-side data bridge framework (KDI-UI-001); only the narrow
  load/action handlers these routes need.
- Kanban board view, task create/edit, task detail, task lifecycle actions,
  dispatch, stats/diagnostics, notifications, triage, swarm, workflow, goal mode
  (other KDI-UI items). The detail route shows only board-level task counts, not
  the task list (that is KDI-UI-003).
- Any **unarchive/restore** action — no such model function or CLI command
  exists; adding one is a separate feature requiring its own BRD + flag.
- `KDI_BOARD` env / `--board` flag surfacing in the UI (CLI-only; the browser
  has no env/flag context and uses `readCurrentBoard()` → `"default"`).
- Path-picker widgets — text inputs only (native form controls first).
- Drag-and-drop, WebSockets/SSE, auth/multi-user (non-goals per backlog).
- Bulk archive/delete (single-board actions only this item).
- Any change to CLI commands, models, db schema, or flag semantics.

## 8. Acceptance Criteria

- **AC-01 (list)** The `boards` route renders one row per board from
  `listBoards(false)` by default with `name`/`slug`, `icon`, `color` swatch,
  `description`, `workdir`, `base_ref`; the row matching `readCurrentBoard()`
  shows a "Current" badge (none when the current file is missing/invalid, and no
  error thrown); each row shows 8 per-status counts from `getBoardStats`.
- **AC-02 (archived toggle)** The "include archived" toggle flips to `true`,
  surfaces archived boards (dimmed + "archived" tag), defaults to `false`, and
  re-loads from `listBoards(includeArchived)`.
- **AC-03 (show)** `boards/[slug]` renders `showBoard(slug, true)` with all 9
  `taskCounts`; an archived board renders with "(archived)" (not 404); a missing
  slug renders `Board "..." not found.`; metadata/default-workdir fields render
  exactly when their flags (`FF_BOARD_METADATA`/`FF_DEFAULT_WORKDIR`) are on.
- **AC-04 (show current)** The `/boards` list route highlights the board whose
  slug equals `readCurrentBoard()` with a "Current" badge; no badge is shown when
  the current file is missing or names a missing board, and no error is thrown.
  The detail route `/boards/[slug]` renders the requested board; a missing slug
  renders `Board "..." not found.`.
- **AC-05 (create)** `boards/new` creates via `createBoard`; invalid slug →
  `assertValidBoardSlug` text; duplicate → `Board with slug "..." already
  exists`; empty metadata → `validateMetadataField` text; form stays mounted
  with values preserved on error.
- **AC-06 (create metadata gate)** With `FF_BOARD_METADATA` off, metadata fields
  are disabled and a submitted metadata value is rejected with
  `"Board metadata feature is not enabled."`; with it on, metadata is stored.
- **AC-07 (create switch)** With `FF_BOARD_CREATE_SWITCH` on and `switch`
  checked, success calls `writeCurrentBoard` and the list shows the badge; with
  the flag off, `switch=true` is rejected with
  `"Board create --switch feature is not enabled."`.
- **AC-08 (edit metadata)** `boards/[slug]/edit` metadata action calls
  `updateBoardMetadata` (gated `FF_BOARD_METADATA`); "at least one field
  required" and empty-string rejection surface verbatim; not-found/archived
  surfaces `"Board \"...\" not found or is archived."`; no partial write.
- **AC-09 (edit default workdir)** The default-workdir action calls
  `setDefaultWorkdir` (gated `FF_DEFAULT_WORKDIR`); empty clears; whitespace-only
  is rejected with `"Default workdir cannot be empty. Omit the path to clear it."`.
- **AC-10 (switch)** "Make current" calls `showBoard(slug, true)` then
  `writeCurrentBoard(slug)`; missing slug rejects with `Board "..." not found.`
  and leaves the current file untouched; archived boards are switchable. With
  `FF_BOARD_SWITCH` off, it is disabled and a POST is rejected with
  `"Board switch feature is not enabled."`.
- **AC-11 (rename name)** Display-name rename calls `updateBoardMetadata(slug,
  { name })` (gated `FF_BOARD_RENAME_HERMES`); slug is unchanged; empty name →
  `"Name cannot be empty."`; flag off →
  `"Board rename (Hermes semantics) feature is not enabled."`.
- **AC-12 (rename slug)** Slug rename calls `renameBoardSlug(old, new)` (gated
  `FF_BOARD_RENAME`); same-slug/conflict/not-found/archived errors surface
  verbatim; the dialog warns the data dir + current file may move/rewrite. On
  success, if `readCurrentBoard()` was the old slug, the current file is
  rewritten to the new slug; navigation follows. Flag off →
  `"Board rename feature is not enabled."`.
- **AC-13 (archive)** Archive requires a confirm naming the slug; on success the
  board leaves the default list and appears under the archived toggle; on
  `Board "..." not found or already archived` the error is shown inline and the
  row reflects truth.
- **AC-14 (hard-delete visibility)** The "Delete permanently" control is
  rendered only when `FF_BOARD_RM_DELETE` is on; when off the selector is absent
  (smoke asserts it is missing — not merely greyed).
- **AC-15 (hard-delete confirm)** The confirm dialog enumerates the cascade and
  requires the operator to type the exact slug; the confirm button is disabled
  until the typed value matches; a non-matching slug does not call
  `removeBoard`; a direct POST without a confirmed-slug field is rejected.
- **AC-16 (hard-delete success)** A confirmed hard-delete calls
  `removeBoard(slug, true)` exactly once; on success the row is gone and the
  board row + on-disk data directory are removed (verifiable via
  `kdi boards list --all` reading the same SQLite); `Board "..." not found` on
  race surfaces inline with no UI "deleted" state.
- **AC-17 (hard-delete gate)** With `FF_BOARD_RM_DELETE=false`, a direct POST is
  rejected with `Board hard-delete is not enabled...` and performs no deletion.
- **AC-18 (current file)** Archiving/deleting/switching never modifies the
  current file except switch (writes the chosen slug) and successful slug-rename
  (rewrites old→new when `current` matched) — matching CLI.
- **AC-19 (master flag)** With `FF_SVELTEKIT_FRONTEND=false`, all board routes
  are unavailable (404/"UI disabled"); with it on, every control matches its
  per-flag CLI availability.
- **AC-20 (no code churn)** No file under `src/models`, `src/commands`,
  `src/resolveBoard.ts`, `src/db.ts`, or `src/flags.ts` is modified
  (review-enforced; only imports).
- **AC-21 (UI smoke)** A smoke test using temp `HOME` + temp `KDI_DB` can: init
  → create a board through the form (with metadata + base ref + switch) → verify
  via `kdi boards show` → show detail with counts matching `kdi boards show` →
  switch to another board and verify `current` → edit name + description → set
  then clear default workdir → rename display name → rename slug of the current
  board and verify `current` moved → archive a board → (with
  `FF_BOARD_RM_DELETE=true`) hard-delete another board with a wrong-then-right
  typed slug, verifying via `kdi boards list --all` that the board, its tasks,
  and its data directory are gone. (Depends on KDI-UI-000/001 for the harness.)
- **AC-22 (build)** `bun run lint`, CLI `bun run build`, and the SvelteKit build
  pass with isolated `KDI_DB`; existing CLI tests remain green.

## 9. Risks and Mitigations

- **Blocked on KDI-UI-000/001:** this item cannot start until the shell and a
  server bridge exist. Mitigation: §3 makes the gate explicit; do not bundle
  the shell into board management.
- **AGENTS.md Never-Do conflict:** adding `apps/web` violates the current
  single-binary/no-`backend`-or-`frontend` wording. This is a KDI-UI-000
  concern, called out here so board management does not get blamed.
  Mitigation: AGENTS.md amendment lands in KDI-UI-000.
- **Irreversible hard-delete:** highest-severity risk. Mitigation: typed-slug
  confirmation, enumerated destruction summary, control hidden when flag off,
  server re-checks flag + confirmed slug, single model entry point
  (`removeBoard(slug, true)`) in one DB transaction — no partial state.
- **No unarchive:** archive is one-way today (no model/CLI restore). Mitigation:
  the UI states archive is soft and where archived boards are visible (the
  archived toggle); no "Restore" button anywhere. A real restore is a separate
  BRD + flag.
- **Current-board file staleness:** archiving/deleting the current board leaves
  `current` pointing at an archived/missing slug (matches CLI). Mitigation:
  documented as intentional (FR-30/AC-18); a follow-up slice may clear it.
- **Slug-rename side effects:** `renameBoardSlug` moves the data directory on
  disk and rewrites `current`. Mitigation: a dedicated confirm dialog enumerating
  those side effects; the model owns atomicity; the UI never constructs paths.
- **Flag matrix:** eight flags touch this item. Mitigation: a single server-side
  capability map is resolved once and passed to the UI; controls render
  disabled with a flag-name tooltip when off; the server re-rejects any value
  submitted for a disabled feature.
- **Client-side bypass:** a malicious client could POST directly. Mitigation:
  every server action re-checks its flag and confirm contract; client gating is
  UX only.
- **N+1 stats queries:** `getBoardStats(slug)` runs per board row; fine at
  expected board counts (tens). `ponytail:` comment will name the upgrade path
  (a single batched stats query across boards) if profiling ever shows it.
- **Polling staleness:** counts may lag. v1 accepts a load-time read per the
  backlog's polling-first non-goal; SSE/WebSocket is a later follow-up.

## 10. Feature Flags

- `ff_sveltekit_frontend` / `FF_SVELTEKIT_FRONTEND` (browser:
  `VITE_FF_SVELTEKIT_FRONTEND`), default `false`, status `Planned` → `InDev`
  when KDI-UI-000 lands. Gates the **whole** UI. Inherited; this item adds no
  new flag of its own.
- Per-action flags reused from the CLI (no new flags):
  - `FF_BOARD_METADATA` — metadata fields (create + edit) and detail display of
    `icon`/`color`/`description`.
  - `FF_BOARD_CREATE_SWITCH` — `switch` after create.
  - `FF_DEFAULT_WORKDIR` — set/clear/ display default workdir.
  - `FF_BOARD_SWITCH` — make current.
  - `FF_BOARD_RENAME_HERMES` — display-name rename.
  - `FF_BOARD_RENAME` — slug rename.
  - `FF_BOARD_RM_DELETE` — hard-delete visibility + endpoint.
  - Archive requires **no** per-action flag (matches CLI).
- **Rollback / deactivation:** Set `FF_SVELTEKIT_FRONTEND=false` to hide the
  entire UI; per-action flags revert individual controls to disabled/hidden. The
  CLI continues to own all board management.
- **Deprecation plan:** N/A (additive UI).

## 11. CLI → UI behavior coverage map

Confirms the parent acceptance ("covers `boards create/list/show/edit/switch/
archive/rm/set-default-workdir/rename` behavior"):

| `boards` behavior | FR(s) | AC(s) |
|---|---|---|
| `list` | FR-1..FR-7 | AC-01, AC-02 |
| `show` | FR-8..FR-10 | AC-03, AC-04 |
| `create` | FR-11..FR-15 | AC-05, AC-06, AC-07 |
| `edit` (metadata) | FR-16, FR-17, FR-19 | AC-08 |
| `set-default-workdir` | FR-16, FR-18, FR-19 | AC-09 |
| `switch` | FR-20, FR-21 | AC-10, AC-18 |
| `rename` (display name) | FR-22 | AC-11 |
| `rename-slug` | FR-23, FR-24 | AC-12, AC-18 |
| `archive` | FR-25, FR-26 | AC-13, AC-18 |
| `rm` (hard-delete) | FR-27..FR-29, FR-30 | AC-14, AC-15, AC-16, AC-17, AC-18 |

Cross-cutting: FR-31..FR-33 / AC-19, AC-20, AC-22. End-to-end: AC-21.

---

## Appendix A — Model surface this item consumes

Validated live in `src/models/board.ts` and `src/resolveBoard.ts`:

- `Board { id, slug, workdir, default_workdir, base_ref, name, icon, color, description, created_at, archived_at }`
- `BoardMetadata { name?, icon?, color?, description? }`
- `BoardWithTaskCounts extends Board { taskCounts: { triage, todo, ready, running, done, blocked, review, scheduled, archived } }` (9 buckets)
- `BoardStats { board, status_counts: {8 buckets, no archived}, assignee_counts, oldest_ready_age_seconds }`
- `createBoard(slug, workdir, baseRef="origin/main", metadata={})` → throws `Board with slug "..." already exists`
- `listBoards(includeArchived=false): Board[]`
- `showBoard(slug, includeArchived=false): BoardWithTaskCounts | null`
- `getBoardStats(slug): BoardStats`
- `setDefaultWorkdir(slug, workdir|null)` → `"Default workdir cannot be empty. Omit the path to clear it."`, `"Board \"...\" not found or is archived."`
- `updateBoardMetadata(slug, metadata)` → `"At least one metadata field is required."`, `"Board \"...\" not found or is archived."`
- `archiveBoard(slug)` → `"Board \"...\" not found or already archived"`
- `renameBoardSlug(old, new)` → `"New slug must differ from the current slug."`, `"Board with slug \"...\" already exists."`, `"Board \"...\" not found or is archived."`; renames data dir; rewrites current if matched
- `removeBoard(slug, hardDelete)` — hard path cascade-deletes `task_events`, `task_runs`, `task_attachments`, `comments`, `dependencies`, `workflow_templates`, `tasks` + `rmSync` board data dir + `DELETE boards`; throws `Board "..." not found`
- `readCurrentBoard(): string | null` / `writeCurrentBoard(slug)` / `resolveBoard(explicitSlug?)` chain (`--board` → `KDI_BOARD` → current file → `"default"`)
- `assertValidBoardSlug(slug)` — slug validation shared with the CLI

## Appendix B — CLI command surface mirrored

Validated live in `src/commands/boards.ts`:

- `boards create <slug> --workdir (req) --base-ref (default origin/main) --name --icon --color --description --switch` — metadata `FF_BOARD_METADATA`, switch `FF_BOARD_CREATE_SWITCH`
- `boards list [--all]`
- `boards switch <slug>` — `FF_BOARD_SWITCH`; uses `showBoard(slug, true)` (allows archived)
- `boards show [slug]` — `resolveBoard()` if omitted; `showBoard(effectiveSlug, true)`; metadata `FF_BOARD_METADATA`, default workdir `FF_DEFAULT_WORKDIR`
- `boards edit <slug> --name --icon --color --description` — `FF_BOARD_METADATA`
- `boards set-default-workdir <slug> [workdir]` — empty clears; `FF_DEFAULT_WORKDIR`
- `boards rename <slug> <name>` — `FF_BOARD_RENAME_HERMES`
- `boards rename-slug <old> <new>` — `FF_BOARD_RENAME`; rewrites current if matched
- `boards archive <slug>` — no per-action flag
- `boards rm <slug> [--delete]` — `--delete` gated by `FF_BOARD_RM_DELETE`