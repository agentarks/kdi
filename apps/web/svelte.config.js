import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    // KDI-UI-001: expose a `~` path alias so the server bridge imports the CLI
    // model layer via `~/models/*` (spec FR-1), matching the root tsconfig
    // `~/* -> src/*` alias the CLI already uses. SvelteKit wires this into both
    // vite resolve.alias and the auto-generated tsconfig, so svelte-check and
    // the adapter-node build both resolve `~` without manual tsconfig `paths`.
    // ponytail: one kit.alias entry instead of duplicated tsconfig + vite config.
    alias: {
      "~": "../../src",
    },
  },
};

// KDI-UI-001: the server bridge imports CLI models that pull `bun:sqlite`.
// The adapter-node SSR bundle targets Node, which cannot load `bun:` modules,
// so externalize it. The UI is only ever run under Bun (dev:web/preview) where
// bun:sqlite resolves at runtime; src/ CLI code is untouched.
// ponytail: external the single Bun-only builtin rather than the whole CLI graph.
config.vite = {
  ...config.vite,
  ssr: { external: ["bun:sqlite"] },
};

export default config;