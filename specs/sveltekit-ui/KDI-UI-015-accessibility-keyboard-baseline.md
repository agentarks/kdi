# Specification: KDI-UI-015 — Accessibility and keyboard baseline

> Parent backlog: `specs/sveltekit-ui-backlog.md` → `KDI-UI-015: Accessibility and keyboard baseline`.
> Scope of this document: the **full** KDI-UI-015 item — a cross-cutting
> quality pass that makes the existing KDI SvelteKit UI operable from the
> keyboard and usable by assistive technology. This is a **spec-writing task**,
> not an implementation. Contracts are validated against the live SvelteKit UI
> code in `apps/web/`.

---

## 1. Business Goal

Ensure the KDI operator UI is keyboard-navigable and screen-reader friendly
from the start. Every interactive element used in the core operator workflow
(board switcher, navigation, board view, filters, forms, task detail, action
menus, and dispatch/observability screens) must be reachable and operable
without a pointing device, and programmatically express its name, role, and
state to assistive technology. This avoids retrofitting accessibility later,
when the component surface is larger.

## 2. Problem Statement

The current SvelteKit app shell and early UI views are built primarily with
mouse-driven interactions in mind. There is no project-wide accessibility
contract: focus states may be missing, form inputs may rely on placeholder text
for labels, icon-only buttons may be invisible to screen readers, and dynamic
updates may not be announced. Operators who cannot use a mouse, or who use
screen readers or voice control, will be unable to operate the tool.

## 3. Prerequisites (hard blockers)

- **KDI-UI-000 — SvelteKit app shell.** `apps/web/` exists; the app shell
  (`+layout.svelte`), board switcher, left navigation, and flag badge are
  in place.
- **KDI-UI-001 — Server-side data bridge.** Server routes and load functions
  exist; the UI can render real data from KDI model functions.
- **KDI-UI-003 — Kanban board view (recommended).** The board view is the most
  complex interactive surface covered by this baseline. If KDI-UI-003 is
  pending, the spec can be applied to whatever views exist; the board view is
  the highest-value verification target.
- **KDI-UI-004..KDI-UI-006 — Forms, detail panel, lifecycle actions
  (recommended).** These screens supply the forms, buttons, menus, and modal
  dialogs that the baseline tests. The spec can be verified incrementally as
  each screen lands.

KDI-UI-015 adds **only** accessibility improvements, shared ARIA utilities, and
tests. It must not introduce new visual features or change business logic.

## 4. Decision Options

1. **Incremental accessibility pass as screens are built.** Wait for each KDI-UI
   screen to land, then add focus/labels/ARIA per screen. Risk: inconsistent
   implementation and gaps. Rejected.
2. **Baseline contract now, enforce in every screen.** Define a small set of
   reusable rules and tests, apply them to the current app shell and all
   screens built before this item, and require them in future screen reviews.
   **Chosen.** Gives a single, testable bar and avoids an expensive retrofit
   later.

## 5. Current vs Desired Behavior

| Aspect | Current (v0 app shell) | Desired (baseline) |
|---|---|---|
| Keyboard navigation | Mouse-driven; no explicit tab order or focus traps | Every interactive element reachable via `Tab`/`Shift+Tab`; logical order matches visual order |
| Focus indicators | Browser default, often subtle | Strong, visible focus ring or outline on all focusable elements |
| Form labels | May rely on placeholders or visual-only text | Every input has a persistent `<label>` or `aria-labelledby`/`aria-label` |
| Icon-only buttons | May have no accessible name | Icon-only buttons expose a name via `aria-label` or visually hidden text |
| Dynamic updates | Silent to screen readers | Status changes, errors, and loading states use an ARIA live region |
| Skip links | None | A skip link lets keyboard users bypass the board switcher and navigation |
| Landmark regions | Generic layout | Header, main, and navigation are marked with `<header>`, `<main>`, `<nav>`, or equivalent roles |
| Action menus/dropdowns | Mouse click only | Openable and navigable with `Enter`, `Space`, `Esc`, and arrow keys |
| Color alone | Status/priority may be indicated only by color | Status and priority also use text or icons with labels |
| Testing | Manual, ad-hoc | Automated accessibility checks run in `bun run check:web` or `bun test` |

## 6. Functional Requirements

### 6.1 Global keyboard navigation (app shell)

- **FR-1** The first focusable element on every page is a **skip link**
  (`<a href="#main-content">Skip to main content</a>`). Activating it moves
  focus to the `<main>` element which has `id="main-content"` and `tabindex="-1"`.
- **FR-2** The board switcher, left navigation, and command/action bar use a
  logical `Tab` order that matches the visual order. No custom `tabindex` values
  except `0` and `-1`.
- **FR-3** All interactive elements in the app shell (links, buttons, inputs,
  selects) show a visible focus indicator. The indicator must have a contrast
  ratio of at least 3:1 against the adjacent background.
- **FR-4** The left navigation is wrapped in `<nav aria-label="Primary">`. Each
  nav link has an `aria-current="page"` attribute when it matches the current
  route.
- **FR-5** The board switcher is a `<select>` or a button with `aria-haspopup`
  and `aria-expanded` if a custom dropdown is used. The current board is
  conveyed to screen readers by the control's label and value, not by color
  alone.

### 6.2 Form controls and labels

- **FR-6** Every `<input>`, `<select>`, and `<textarea>` has a visible
  `<label>` with a `for` attribute matching the input's `id`, or is grouped in
  a `<fieldset>` with a `<legend>`. No placeholder is used as a substitute for
  a label.
- **FR-7** Inputs that have no visible label (e.g. search, filter chips) use
  `aria-label` or `aria-labelledby` with a stable, descriptive name.
- **FR-8** Required fields are marked by the `required` attribute and visually
  indicated (e.g. `aria-required="true"` plus a visible indicator). Validation
  errors are associated with the input using `aria-describedby`.
- **FR-9** Form error messages are rendered inside an ARIA live region
  (`aria-live="polite"`) so screen readers announce them when they appear.
- **FR-10** Groups of radio buttons or checkboxes (e.g. filter panels) are
  wrapped in `<fieldset>` with a `<legend>` describing the group.

### 6.3 Buttons and icon-only controls

- **FR-11** All `<button>` elements have an accessible name. Buttons with only
  an icon use `aria-label` or a visually hidden `<span>`.
- **FR-12** Disabled buttons use `disabled` (or `aria-disabled="true"` when the
  button still needs focus). The reason for the disabled state is visible or
  available via `aria-describedby` when it is not obvious.
- **FR-13** Toggle buttons (e.g. show/hide archived, pause/resume polling) use
  `aria-pressed` or `aria-expanded` to communicate state.
- **FR-14** Destructive action buttons (archive, delete, reclaim) are
  focusable, named, and trigger a confirmation step before mutation.

### 6.4 Tables and board view

- **FR-15** Data tables use `<table>`, `<thead>`, `<th scope="col">`, and
  `<tbody>`. If a visual grid is implemented with `div`s, it exposes
  `role="table"`, `role="row"`, `role="columnheader"`, and `role="cell"`.
- **FR-16** Each task row/cell has focusable controls (promote, block, edit,
  open detail) and each control has an accessible name that includes the task
  title or id (e.g. `aria-label="Edit task 42: Update README"`).
- **FR-17** Sortable column headers use `aria-sort="ascending"`,
  `aria-sort="descending"`, or `aria-sort="none"`.
- **FR-18** The board view uses color plus text/icon to indicate status,
  priority, and staleness. A task in `blocked` status is not communicated by a
  red border alone.

### 6.5 Dialogs and action menus

- **FR-19** Any modal dialog (confirmation, reason input, form in a modal) traps
  focus while open, restores focus to the trigger on close, and closes on `Esc`.
- **FR-20** Dialogs use `role="dialog"` with `aria-modal="true"` and an
  accessible title (`aria-labelledby` pointing to the dialog heading).
- **FR-21** Action menus (e.g. task overflow menu) use `role="menu"` or
  `role="listbox"` semantics, are opened with `Enter`/`Space`, and allow
  navigation with arrow keys and dismissal with `Esc`.
- **FR-22** When a modal or menu is closed, keyboard focus returns to the
  element that opened it.

### 6.6 Live regions and announcements

- **FR-23** The app shell includes a single, persistent ARIA live region
  (`aria-live="polite" aria-atomic="true"`) for status announcements. All
  transient status messages (e.g. "Task created", "Dispatch pass complete",
  "Network error") are announced through it.
- **FR-24** Loading states during server navigation or form submission are
  announced with text such as "Loading" or "Saving" via the live region.
- **FR-25** Counts of filtered results (e.g. "12 tasks match") are updated in
  the live region when the filter changes.

### 6.7 Reduced motion and visual accessibility

- **FR-26** The UI respects `prefers-reduced-motion` by disabling non-essential
  animations (e.g. spinner pulses, transition animations) when the media query
  is active.
- **FR-27** Text and interactive elements meet WCAG 2.2 AA contrast
  requirements (4.5:1 for normal text, 3:1 for large text and UI components).
  This is a project-wide goal; KDI-UI-015 verifies the baseline for the app
  shell, board view, and forms.
- **FR-28** Focus indicators are visible at all times and do not rely on
  mouse hover.

## 7. Scope

In scope:
- A reusable accessibility test suite that validates the baseline against the
  app shell and each existing UI screen.
- Adding `aria-*`, labels, focus management, skip links, and live-region support
  to `apps/web/src/` components and routes as needed to meet the acceptance
  criteria.
- A small shared utility for focus management and live announcements if the
  same pattern is needed in more than one place.
- Playwright selectors that prefer stable roles and names over CSS selectors.

Out of scope (owned by other backlog items):
- KDI-UI-000..KDI-UI-014: building the screens themselves. This item only adds
  the accessibility layer to them.
- Full WCAG 2.2 AAA audit.
- Auth, multi-user, or role-based accessibility features.
- Custom screen-reader-only features beyond standard ARIA/semantic HTML.

## 8. Dependencies

- KDI-UI-000 (SvelteKit app shell) must exist and `FF_SVELTEKIT_FRONTEND` must
  be wired in `apps/web/src/hooks.server.ts`.
- KDI-UI-001 (server-side data bridge) must be in place so the UI can render
  real screens to test.
- KDI-UI-003 (Kanban board view) is the highest-value verification target.
- KDI-UI-004 (task create/edit UI), KDI-UI-005 (task detail panel), and
  KDI-UI-006 (lifecycle actions) supply the forms and menus to test.
- Optional: `playwright` or similar browser testing tool if the project
  chooses to automate accessibility checks in browser tests. The baseline can
  be verified with manual keyboard + screen-reader smoke checks if automation is
  not available.
- No new runtime dependencies for the SvelteKit app unless the chosen test
  framework requires one.

## 9. Non-Goals

- Drag-and-drop reordering accessibility. (D&D is explicitly out of scope for
  v1; if it is added later, it will have its own accessibility item.)
- Real-time WebSocket/SSE accessibility beyond the existing live-region
  pattern.
- Accessibility features that require a backend change (e.g. localized text
  strings served from the server).
- Full color-blind simulation testing or high-contrast themes.
- Screen reader-specific shortcuts beyond standard keyboard navigation.

## 10. Architecture Decisions

1. **Semantic HTML first.** Use the correct HTML element (`<button>`,
   `<a>`, `<label>`, `<nav>`, `<main>`, `<table>`) before adding ARIA roles.
   ARIA is only used to supplement or repair semantic gaps.
2. **No custom focus-ring suppression.** Global CSS may reset outlines but must
   provide a visible `:focus-visible` style for every focusable element. Default
   browser focus styles are acceptable.
3. **One live region, many messages.** A single live region in the app shell
   avoids multiple competing announcements. Components announce by pushing
   text into the region, not by creating their own.
4. **Stable selectors for tests.** Playwright tests use role/name selectors
   (`getByRole`, `getByLabel`, `getByText`) or stable `input[name="..."]`
   selectors. CSS class selectors are avoided for test assertions.
5. **No new feature flag.** Accessibility is not gated behind a flag; it is a
   baseline requirement for every UI screen. The entire UI remains gated by
   `FF_SVELTEKIT_FRONTEND` as before.
6. **Minimal shared utility.** A single helper for announcements and a single
   helper for focus trapping are acceptable; anything larger is deferred until
   a second screen needs it.

## 11. Resource Map

No new server routes are required. KDI-UI-015 touches the following client-side
locations:

| Location | Change |
|---|---|
| `apps/web/src/app.css` | Add or confirm `:focus-visible` styles and `prefers-reduced-motion` media query. |
| `apps/web/src/routes/+layout.svelte` | Add skip link, `<main id="main-content" tabindex="-1">`, live region, `<nav aria-label="Primary">`, and focus-visible styles. |
| `apps/web/src/routes/+page.svelte` (and later screen pages) | Ensure heading structure, landmark regions, and no unreachable controls. |
| `apps/web/src/lib/components/` (if any) | Add labels, `aria-expanded`, `aria-pressed`, `aria-describedby`, and accessible names to buttons/inputs. |
| `apps/web/src/lib/a11y.ts` (optional) | Shared helper for live-region announcements and maybe focus trapping. |
| `tests/web/` or `apps/web/tests/` | Accessibility/keyboard smoke tests. |

## 12. Non-Functional Requirements

- The accessibility additions must not break `bun run check:web` or
  `bun run build:web`.
- No new runtime dependencies unless the team chooses to add an accessibility
  testing library (e.g. `@axe-core/playwright`); such a dependency is optional.
- The baseline must be verifiable in a single automated or manual run that
  covers the app shell, navigation, board view, filters, forms, and lifecycle
  action buttons.

## 13. Edge Cases

| Scenario | Expected behavior |
|---|---|
| No JavaScript enabled | The app shell, skip link, and native form controls still function; enhanced menus degrade to links or simple selects. |
| Focus moves inside a modal | `Tab` cycles within the modal; `Esc` closes it and returns focus to the trigger. |
| A long filter panel is open | Focus stays within the panel; close button is reachable and focus returns to the filter toggle on close. |
| Icon-only button has no adjacent text | Screen reader announces the `aria-label` or visually hidden text. |
| Status is communicated only by color in an existing screen | Add text or an icon with `aria-label` to satisfy the baseline. |
| `prefers-reduced-motion` is on | Animations/transitions are suppressed except for essential loading spinners (which may be simplified). |
| Validation error appears | Focus is moved to the first invalid input and the error is announced via the live region. |
| Dynamic list updates (e.g. filter changes) | Live region announces "N tasks found" or equivalent. |
| Empty state | Empty state text is inside the live region or the main content so it is announced when it appears. |

## 14. Feature Flag Requirements

No new feature flag is introduced. The entire UI remains gated by the existing
`ff_sveltekit_frontend` / `FF_SVELTEKIT_FRONTEND` flag (registered in
`specs/feature-flags.md`, default `false`). Accessibility improvements are part
of the UI when it is enabled; they are not separately toggled.

## 15. Acceptance Criteria

- [ ] AC-01: The app shell contains a visible skip link that moves focus to the
      `<main>` element when activated.
- [ ] AC-02: Every interactive element in the app shell, board view, and forms
      is reachable and operable using only the keyboard (`Tab`, `Shift+Tab`,
      `Enter`, `Space`, `Esc`, arrow keys where appropriate).
- [ ] AC-03: Every focusable element has a visible `:focus-visible` indicator.
- [ ] AC-04: Every form input has a visible label or an accessible name via
      `aria-label`/`aria-labelledby`; no input relies solely on placeholder
      text.
- [ ] AC-05: Every icon-only button has an accessible name.
- [ ] AC-06: The left navigation uses `<nav aria-label="Primary">` and marks
      the current page with `aria-current="page"`.
- [ ] AC-07: Status, priority, and diagnostic severity are not communicated by
      color alone; text or icon labels accompany color indicators.
- [ ] AC-08: A single ARIA live region announces transient status messages,
      loading states, and result counts.
- [ ] AC-09: Modal dialogs trap focus, close on `Esc`, and return focus to the
      trigger on close.
- [ ] AC-10: Action menus are openable with `Enter`/`Space`, navigable with
      arrow keys, and dismissible with `Esc`.
- [ ] AC-11: `prefers-reduced-motion` disables non-essential animations.
- [ ] AC-12: Playwright tests use stable selectors (`getByRole`, `getByLabel`,
      `getByText`, `input[name=...]`) and no test asserts on CSS class names.
- [ ] AC-13: A keyboard smoke test exercises the core path: focus skip link →
      navigate to a board view → tab through a task row → open a task action
      menu → trigger a non-destructive action (e.g. "open detail") using only
      the keyboard.
- [ ] AC-14: `bun run check:web` and `bun run build:web` pass with no new type
      or accessibility-related errors. (Optional but recommended: an automated
      accessibility check reports no critical or serious issues on the app
      shell, board view, and form screens.)
- [ ] AC-15: `bun run lint` and CLI `bun run build` are unaffected.

## 16. Verification Notes

Implementation should prove:
- Manual keyboard walkthrough of the app shell, board view, and one form.
- Screen-reader sanity check (VoiceOver or NVDA) of the board view, confirming
  names and roles for controls.
- If Playwright is available, add one test that navigates the app shell using
  only keyboard events and asserts on accessible names.
- If an automated accessibility checker (axe, Lighthouse) is available, run it
  against `/`, `/tasks` (or board view), and any form route; document any
  "serious" or "critical" findings and fix them or file follow-up items.
- Verify that no new selector in tests uses a CSS class as its primary locator.

## 17. Risks / Open Questions

- **Risk: accessibility work is deferred until screens are built.** This is a
  cross-cutting baseline; if screens are built after this item, they must be
  held to the same standard in review. **Mitigation:** the acceptance criteria
  are written as a checklist that can be applied to any new screen.
- **Risk: custom components replace native controls.** A future screen might
  build a custom dropdown or calendar. The baseline requires those custom widgets
  to implement full keyboard/ARIA behavior. **Mitigation:** prefer native
  `<select>`, `<input type="date">`, and `<button>` until a custom widget is
  unavoidable; when unavoidable, include keyboard/ARIA behavior in its own
  acceptance criteria.
- **Risk: Svelte 5 runes or transitions interfere with focus management.**
  **Mitigation:** test focus behavior after mount/update in the smoke test; if
  a transition steals focus, add `focus-visible` and `onMount` guards.
- **Open question:** Should the project add `@axe-core/playwright` or another
  automated accessibility library? Optional; the baseline can be verified with
  keyboard tests and manual checks first.
- **Open question:** Should the app ship a high-contrast theme or just rely on
  system focus styles? Out of scope for v1; focus-visible styles are the
  baseline.

## 18. Gaps Discovered

- **No shared live-region utility.** If the app shell does not yet have a live
  region, one must be added.
- **No global `:focus-visible` style contract.** CSS may reset outlines; the
  baseline requires a deliberate, visible focus style.
- **No accessibility test harness.** The project may need to add Playwright or
  a similar tool to automate keyboard/screen-reader checks. If not available,
  manual verification is required.
- **No test selector policy.** Existing or future tests may rely on CSS class
  selectors. This spec establishes a stable selector policy for UI tests.

## 19. Migration Notes

- No database migration.
- No change to `src/db.ts`, `src/models/*`, `src/commands/*`, or
  `src/flags.ts`.
- No change to the feature-flag registry (`specs/feature-flags.md`).

## 20. STATUS.md Update Notes

Add a section under the SvelteKit UI Backlog area:

```markdown
## KDI-UI-015: Accessibility and keyboard baseline — Spec
- [x] BRD drafted at `specs/sveltekit-ui/KDI-UI-015-accessibility-keyboard-baseline.md`
- [ ] Skip link, visible focus states, and landmark regions in app shell
- [ ] Labels and ARIA names on all form inputs and icon-only buttons
- [ ] Keyboard-operable board view, filters, forms, and action menus
- [ ] ARIA live region for status announcements and loading states
- [ ] `prefers-reduced-motion` support and contrast/focus contract
- [ ] Playwright tests use stable role/name selectors; no CSS-class-based assertions
- [ ] Keyboard smoke test covers core operator path
- [ ] `bun run check:web` and `bun run build:web` pass
```

## 21. Spec Location

`specs/sveltekit-ui/KDI-UI-015-accessibility-keyboard-baseline.md`

## 22. Worktree Branch Name

`docs/kdi-ui-015-accessibility-keyboard-baseline-spec`

(Implementation item; implementer creates a worktree per `AGENTS.md`. Spec
authoring for this BRD is non-editing and runs in the shared checkout.)
