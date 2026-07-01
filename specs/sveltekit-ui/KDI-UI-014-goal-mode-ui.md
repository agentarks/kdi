# Specification: KDI-UI-014 — Goal Mode UI

> Parent backlog: `specs/sveltekit-ui-backlog.md` → `KDI-UI-014: Goal mode UI`.
> Scope of this document: the **full** KDI-UI-014 item — richer SvelteKit UI treatment for goal-mode tasks. It intentionally does **not** add the create/edit form fields (KDI-UI-004) or lifecycle mutations (KDI-UI-006). Behavior contracts are validated against `src/models/task.ts`, `src/models/taskEvent.ts`, `src/flags.ts`, `specs/feature-flags.md`, and `specs/brd-kdi-038-goal-mode.md`.

---

## 1. Business Goal

Give operators clear, focused goal-mode affordances in the SvelteKit UI: a visual indicator on task cards in the board view, a dedicated goal-mode card on the task detail panel, and a timeline of goal-turn events. The UI must reuse the existing task fields and event stream produced by BRD-KDI-038 and already exposed by KDI-UI-004/KDI-UI-005, and it must be gated by the same feature flags so goal-mode treatment only appears when the feature is enabled.

## 2. Problem Statement

Goal-mode tasks carry a multi-turn budget, a judge profile, and a continuation event stream that normal tasks do not. Without dedicated UI treatment, operators cannot distinguish goal tasks from single-turn tasks in the board view or easily see how many turns remain and whether the goal loop continued, finished, or exhausted its budget. The underlying fields are already stored and surfaced in raw form by KDI-UI-004 (create/edit form) and KDI-UI-005 (detail metadata), but those surfaces do not provide the focused, timeline-rich display that goal-mode tasks need for monitoring and triage.

## 3. Prerequisites (hard blockers)

- **KDI-UI-000 — SvelteKit app shell.** `apps/web` exists; `FF_SVELTEKIT_FRONTEND` gates the whole UI.
- **KDI-UI-001 — server-side data bridge.** SvelteKit server routes can call existing KDI models and return UI-shaped JSON.
- **KDI-UI-003 — Kanban board view.** Task cards exist and can be extended with a goal-mode indicator.
- **KDI-UI-004 — Task create/edit UI.** The create form already supports `goal_mode`, `goal_max_turns`, and `goal_judge_profile`; KDI-UI-014 only links to it with goal mode pre-selected.
- **KDI-UI-005 — Task detail panel.** The detail panel already returns the task aggregate and events; KDI-UI-014 adds a richer goal-mode display to that panel.
- **KDI-UI-006 — Task lifecycle actions.** Unblocking a task whose `block_reason` is "Goal max turns exhausted" resets `goal_remaining_turns` to `goal_max_turns`; KDI-UI-014 only reflects that reset in the UI.
- **BRD-KDI-038 — Goal mode backend.** Defines the columns, events, and dispatcher behavior that the UI will display.

KDI-UI-014 adds only SvelteKit UI components and consumes existing data; it must not modify `src/models/*`, `src/commands/*`, `src/db.ts`, or `src/flags.ts`.

## 4. Scope

In scope:
- A **goal-mode indicator/badge** on task cards in the kanban board view (KDI-UI-003) when `task.goal_mode === true`.
- A **dedicated goal-mode card/panel** on the task detail page (KDI-UI-005) showing:
  - `goal_max_turns`
  - `goal_remaining_turns`
  - `goal_judge_profile`
  - turn budget visual (e.g. "remaining / max" or progress bar)
- A **goal-turn event timeline** in the detail panel rendering `goal_turn` events with their verdict (`continue`, `done`, `exhausted`) and any note/summary.
- A **"Create goal-mode task"** shortcut from the board view or detail panel that links to `boards/[slug]/tasks/new?goal=1` (or equivalent) so the create form (KDI-UI-004) opens with goal mode pre-selected.
- Server-side and client-side visibility gating by `FF_GOAL_MODE` and `FF_SVELTEKIT_FRONTEND`.

Out of scope (explicitly):
- The create/edit form fields for goal mode (KDI-UI-004 owns `goal_mode`, `goal_max_turns`, `goal_judge_profile`).
- Lifecycle mutations such as unblock, promote, block, complete, assign, or dispatch (KDI-UI-006 and BRD-KDI-038).
- Backend dispatcher goal-loop behavior (BRD-KDI-038).
- New feature flags, server endpoints, or database schema changes.
- Inline editing of goal-mode fields from the detail panel (edits go through KDI-UI-004 or KDI-UI-006).
- Custom judge verdict rendering beyond the structured payload stored in `goal_turn` events.

## 5. Current vs Desired Behavior

| Aspect | Current (CLI + raw UI) | Desired (KDI-UI-014) |
|---|---|---|
| Goal task visibility in board | `kdi list` shows raw columns; board view shows no goal-mode indicator | Board task card shows a goal-mode badge |
| Goal task inspection | `kdi show` prints raw goal fields; KDI-UI-005 shows them in metadata | Detail panel has a dedicated goal-mode card with budget and judge profile |
| Turn history | `kdi tail` shows `goal_turn` event payloads as JSON | Detail panel renders a readable goal-turn timeline |
| Create goal-mode task | Operator navigates to create form and checks goal mode manually | Shortcut/link pre-selects goal mode in KDI-UI-004 form |
| Feature gating | CLI rejects goal options when `FF_GOAL_MODE=false` | UI hides goal-mode indicators and card when flag is off |

## 6. Functional Requirements

### 6.1 Board view indicator

- **FR-1** When `FF_GOAL_MODE=true` and `FF_SVELTEKIT_FRONTEND=true`, the kanban board view task card (KDI-UI-003) displays a small goal-mode indicator/badge for any task where `goal_mode === true`.
- **FR-2** The badge shows at least the remaining-turns count (e.g. "12/20 turns") or a compact icon with a tooltip that expands to "Goal mode: 12/20 turns, judge=ralph".
- **FR-3** When `FF_GOAL_MODE=false`, the badge is not rendered and no goal-mode data is fetched or displayed.
- **FR-4** When `FF_GOAL_MODE=true` but the task is not goal-mode, the badge is absent.
- **FR-5** The badge does not alter the card layout so severely that other metadata (status, assignee, priority, tenant) becomes unreadable. A minimal icon + text pattern is preferred.

### 6.2 Detail panel goal-mode card

- **FR-6** When `FF_GOAL_MODE=true` and `task.goal_mode === true`, the task detail panel (KDI-UI-005) renders a dedicated goal-mode card/panel above or alongside the existing metadata section.
- **FR-7** The card displays:
  - `Goal mode: yes`
  - `Goal max turns: <goal_max_turns>`
  - `Goal remaining turns: <goal_remaining_turns>`
  - `Goal judge profile: <goal_judge_profile>`
- **FR-8** The card visually indicates budget pressure, e.g.:
  - normal when remaining > 25% of max
  - warning when remaining ≤ 25% of max and > 0
  - danger when remaining === 0 or task is blocked with reason "Goal max turns exhausted"
- **FR-9** When `FF_GOAL_MODE=false` or `task.goal_mode === false`, the goal-mode card is not rendered and the detail panel falls back to the existing KDI-UI-005 metadata display.
- **FR-10** The card is read-only; it does not provide inline editing of `goal_max_turns` or `goal_judge_profile`. Edits go to KDI-UI-004.

### 6.3 Goal-turn event timeline

- **FR-11** The detail panel renders a "Goal turns" timeline when `FF_GOAL_MODE=true`, `task.goal_mode === true`, and at least one `goal_turn` event exists for the task.
- **FR-12** Each timeline entry shows:
  - turn number (1-indexed from `payload.turn`)
  - verdict (`continue`, `done`, or `exhausted`)
  - `remaining_after` value
  - optional `note` or `summary` from the payload
  - event timestamp
- **FR-13** Timeline entries are sorted chronologically by turn number (ascending) or by event timestamp (ascending); the UI chooses one and documents it.
- **FR-14** When no `goal_turn` events exist, the timeline shows an empty state such as "No goal turns recorded yet."
- **FR-15** The timeline reuses the events already returned by the KDI-UI-005 aggregate or `/events` route; no new server endpoint is required unless the aggregate does not expose event payloads.

### 6.4 Create goal-mode task link

- **FR-16** The board view and/or task detail panel provide a link/button to create a new goal-mode task, e.g. `boards/[slug]/tasks/new?goal=1`.
- **FR-17** The link is visible only when `FF_GOAL_MODE=true` and `FF_SVELTEKIT_FRONTEND=true`.
- **FR-18** Following the link opens the KDI-UI-004 create form with the `goal_mode` checkbox pre-checked. The KDI-UI-004 form then enforces `goal_max_turns` and `goal_judge_profile` as it already does.
- **FR-19** If the link is followed when `FF_GOAL_MODE=false`, the KDI-UI-004 create form rejects the pre-selected goal mode server-side and displays its existing disabled/gated message.

### 6.5 Cross-cutting

- **FR-20** The whole UI renders only when `FF_SVELTEKIT_FRONTEND=true` (server-side gate). With it off, the routes are unavailable.
- **FR-21** Goal-mode affordances render only when `FF_GOAL_MODE=true`. The server-side data contract may still include the columns, but the UI must not display them when the flag is off.
- **FR-22** KDI-UI-014 adds only SvelteKit components and consumes existing data from KDI-UI-003 and KDI-UI-005. It must not modify `src/models/*`, `src/commands/*`, `src/db.ts`, or `src/flags.ts`.

## 7. Data Contract

### 7.1 Routes and data sources

| Source | Purpose | Notes |
|---|---|---|
| KDI-UI-003 board view task card | Add goal-mode badge | Consumes the same task summary that already includes `goal_mode`, `goal_max_turns`, `goal_remaining_turns`, `goal_judge_profile` or can be extended to include them. |
| KDI-UI-005 detail aggregate (`/api/boards/[slug]/tasks/[id]/detail`) | Add goal-mode card | The `task` object already contains the goal-mode columns. |
| KDI-UI-005 events section or `/api/boards/[slug]/tasks/[id]/events` | Goal-turn timeline | Filter `events` by `kind === "goal_turn"`. |
| KDI-UI-004 create form | Goal-mode shortcut | Link to `boards/[slug]/tasks/new?goal=1` (or equivalent query param). |

### 7.2 Task fields consumed

The UI reads these existing fields from the task object (already returned by KDI-UI-005):

| Field | Type | Display |
|---|---|---|
| `goal_mode` | `boolean` | Badge/card visibility |
| `goal_max_turns` | `number \| null` | "Goal max turns" |
| `goal_remaining_turns` | `number \| null` | "Goal remaining turns" and budget pressure |
| `goal_judge_profile` | `string \| null` | "Goal judge profile" |

### 7.3 Event shape consumed

Goal-turn events are already emitted by the dispatcher. The UI reads `TaskEvent` rows where `kind === "goal_turn"` and parses the payload as:

```typescript
interface GoalTurnPayload {
  turn: number;
  max_turns: number;
  remaining_after: number;
  verdict: "continue" | "done" | "exhausted";
  note?: string;
  summary?: string;
}
```

No new server endpoint is introduced by this item. If the KDI-UI-005 aggregate does not include event payloads, that gap is raised against KDI-UI-005, not patched here.

## 8. Feature Flags

- `ff_sveltekit_frontend` / `FF_SVELTEKIT_FRONTEND` (browser: `VITE_FF_SVELTEKIT_FRONTEND`), default `false`, status `InDev`. Gates the **whole** SvelteKit UI. Inherited; this item adds no new flag.
- `ff_goal_mode` / `FF_GOAL_MODE`, default `false`, status `InDev`. Gates all goal-mode UI affordances: board badge, detail card, goal-turn timeline, and the create-goal-mode shortcut.

No new feature flag is introduced by this BRD.

## 9. Acceptance Criteria

- **AC-01 (flag on, badge visible)** With `FF_SVELTEKIT_FRONTEND=true` and `FF_GOAL_MODE=true`, a goal-mode task rendered in the board view shows a goal-mode indicator/badge with the remaining/max turns or a tooltip that reveals them.
- **AC-02 (flag off, badge hidden)** With `FF_GOAL_MODE=false`, the board view does not show any goal-mode indicator on goal-mode tasks, and no goal-mode data is rendered in the UI.
- **AC-03 (detail card visible)** With `FF_GOAL_MODE=true`, the task detail panel for a goal-mode task displays the goal-mode card showing `goal_max_turns`, `goal_remaining_turns`, and `goal_judge_profile`.
- **AC-04 (detail card hidden)** With `FF_GOAL_MODE=false` or for a non-goal-mode task, the detail panel does not show the goal-mode card.
- **AC-05 (goal-turn timeline)** With `FF_GOAL_MODE=true`, the detail panel for a goal-mode task renders a timeline of `goal_turn` events showing turn number, verdict, remaining_after, and note/summary when present.
- **AC-06 (empty timeline)** When a goal-mode task has no `goal_turn` events, the timeline section shows an empty-state message such as "No goal turns recorded yet."
- **AC-07 (unblock reset reflected)** After a goal-mode task blocked with reason "Goal max turns exhausted" is unblocked (KDI-UI-006), the detail panel refreshes and shows `goal_remaining_turns` reset to `goal_max_turns`.
- **AC-08 (create shortcut)** With `FF_GOAL_MODE=true`, the board view or detail panel provides a visible "Create goal-mode task" shortcut that links to the create form with goal mode pre-selected.
- **AC-09 (master flag)** With `FF_SVELTEKIT_FRONTEND=false`, the goal-mode UI is unavailable along with the rest of the SvelteKit UI.
- **AC-10 (build)** `bun run lint`, CLI `bun run build`, `bun run check:web`, and `bun run build:web` pass with an isolated `KDI_DB`; no new type errors are introduced.

## 10. Risks and Open Questions

- **Blocked on KDI-UI-005 event payload shape:** if the aggregate endpoint does not expose the full `payload` of `goal_turn` events, the timeline cannot render note/summary/verdict details. Mitigation: verify the KDI-UI-005 contract before implementation; if the payload is missing, the gap belongs to KDI-UI-005, not KDI-UI-014.
- **Board view clutter:** adding a badge to every task card could crowd the kanban layout. Mitigation: keep the badge compact (icon + remaining turns or icon-only with tooltip) and follow the existing card spacing from KDI-UI-003.
- **Open question:** Should the goal-mode card offer a one-click "Unblock and reset turns" action when the task is blocked with reason "Goal max turns exhausted"? This BRD keeps the card read-only because lifecycle actions are owned by KDI-UI-006; a future slice can add the action if operators need it.

## 11. STATUS.md Update Notes

Add a section under the SvelteKit UI Backlog area:

```markdown
## KDI-UI-014: Goal Mode UI — Spec
- [x] BRD/spec drafted at `specs/sveltekit-ui/KDI-UI-014-goal-mode-ui.md`
- [ ] Goal-mode indicator/badge on board view task cards when `FF_GOAL_MODE=true`
- [ ] Dedicated goal-mode card on task detail panel showing max turns, remaining turns, and judge profile
- [ ] Goal-turn event timeline rendering verdicts (`continue`, `done`, `exhausted`) and notes
- [ ] "Create goal-mode task" shortcut linking to create form with goal mode pre-selected
- [ ] Acceptance: UI is hidden when `FF_GOAL_MODE=false` and unavailable when `FF_SVELTEKIT_FRONTEND=false`
- [ ] `bun run lint`, CLI build, `bun run check:web`, and `bun run build:web` pass
```

## 12. Spec Location

`specs/sveltekit-ui/KDI-UI-014-goal-mode-ui.md`

## 13. Worktree Branch Name

`feat/kdi-ui-014-goal-mode-ui`

(Implementation item; implementer creates a worktree per `AGENTS.md`. Spec authoring for this BRD is non-editing and runs in the shared checkout.)
