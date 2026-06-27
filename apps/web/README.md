# @kdi/web — kdi operator UI (SvelteKit)

Gated behind `FF_SVELTEKIT_FRONTEND` / `VITE_FF_SVELTEKIT_FRONTEND` (default
`false`). KDI-UI-000 ships only the app shell; server-side data routes land in
KDI-UI-001. The kdi CLI build (`bun run build`) is unchanged.

## Run (isolated DB)

```bash
cp .env.example .env               # enables the flag + isolated KDI_DB
bun install                         # at repo root (workspace install)
bun run dev:web                     # vite dev on http://localhost:5173
```

With the flag off, every route redirects to `/disabled`.

## Check / build

```bash
bun run check:web     # svelte-check
bun run build:web     # vite build (adapter-node -> apps/web/build)
bun run build         # kdi CLI binary (unchanged)
```

## Layout

- `src/routes/+layout.svelte` — app shell: board switcher, left nav, work area,
  command bar, flag badge.
- `src/routes/+page.svelte` — board work-area placeholder (KDI-UI-003 fills it).
- `src/routes/[...path]/+page.svelte` — placeholder for unbuilt nav views.
- `src/routes/disabled/+page.svelte` — flag-off screen.
- `src/hooks.server.ts` — `FF_SVELTEKIT_FRONTEND` gate.
- `src/lib/components/` — `FlagBadge`, `Placeholder`.