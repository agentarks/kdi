import { defineConfig } from "@playwright/test";

// Playwright is gated behind a separate `test:web:e2e` script and scoped to
// `./e2e/*.e2e.ts`. The `.e2e.ts` extension is intentionally NOT `.test.ts`/
// `.spec.ts` so the root `bun run test` (which matches *.test/*.spec) never
// tries to load @playwright/test under bun:test. See KDI-UI-008 AC-14.
export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.e2e\.ts$/,
  // The e2e suite shares one dev server + one isolated KDI_DB; no parallelism.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    headless: true,
    // baseURL is set per run; the test navigates with absolute URLs because the
    // dev server is spawned on a random port for isolation.
  },
});
