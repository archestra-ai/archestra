import { defineConfig, devices } from "@playwright/test";

const IS_CI = !!process.env.CI;

export default defineConfig({
  testDir: "./tests-integration",
  // Path aliases live in tests-integration/tsconfig.json (resolves @shared/*
  // into the workspace's shared package without relying on Node's ESM scoped
  // package resolver, which rejects `@shared` as a bare name).
  tsconfig: "./tests-integration/tsconfig.json",
  // Tests share a single Next.js dev server with a process-global MSW handler
  // list. Running them in parallel would let one test's `mswControl.use(...)`
  // override leak into another test's request. Serialize until the suite is
  // sharded across multiple dev-server workers.
  fullyParallel: false,
  workers: 1,
  forbidOnly: IS_CI,
  retries: IS_CI ? 2 : 0,
  timeout: 60_000,
  reporter: IS_CI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:3010",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  expect: { timeout: 10_000 },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "next dev -H 127.0.0.1 -p 3010",
    url: "http://127.0.0.1:3010",
    reuseExistingServer: !IS_CI,
    timeout: 120_000,
    env: {
      NEXT_PUBLIC_API_MOCKING: "enabled",
      // Point the SDK at an unreachable port instead of the real backend so
      // any SSR fetch that escapes MSW fails loudly with ECONNREFUSED rather
      // than silently hitting a developer's locally running Fastify on 9000.
      // MSW Node registers handlers against this URL via getJson() and
      // intercepts before the socket dial, so reachability is irrelevant for
      // the happy path.
      ARCHESTRA_INTERNAL_API_BASE_URL: "http://127.0.0.1:1",
      NEXT_PUBLIC_SENTRY_DSN: "",
    },
  },
});
