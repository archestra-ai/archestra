import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const IS_CI = !!process.env.CI;
// Mirrors ARCHESTRA_FRONTEND_INT_TESTS_PORT in dev/Tiltfile.dev so a parallel
// Tilt session (separate worktree) runs tests against its own MSW frontend
// instead of the main worktree's :3010. `pnpm dev:stack:up` writes the value
// to platform/.env, so we fall back to reading it from there when the env var
// isn't already exported into the Playwright process.
const INT_TESTS_PORT = readIntTestsPort() ?? "3010";
const INT_TESTS_URL = `http://127.0.0.1:${INT_TESTS_PORT}`;

function readIntTestsPort(): string | undefined {
  if (process.env.ARCHESTRA_FRONTEND_INT_TESTS_PORT) {
    return process.env.ARCHESTRA_FRONTEND_INT_TESTS_PORT;
  }
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const content = readFileSync(resolve(here, "../.env"), "utf8");
    return content.match(
      /^\s*ARCHESTRA_FRONTEND_INT_TESTS_PORT\s*=\s*(\S+)/m,
    )?.[1];
  } catch {
    return undefined;
  }
}

export default defineConfig({
  testDir: "./tests-integration",
  // Path aliases live in tests-integration/tsconfig.json (resolves @archestra/shared/*
  // onto the workspace's shared sources directly, so specs can import shared
  // subpaths without going through the package's published exports map).
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
    baseURL: INT_TESTS_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  expect: { timeout: 10_000 },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `next dev -H 127.0.0.1 -p ${INT_TESTS_PORT}`,
    url: INT_TESTS_URL,
    reuseExistingServer: !IS_CI,
    timeout: 120_000,
    env: {
      NEXT_PUBLIC_API_MOCKING: "enabled",
      // Point the SDK at an unreachable port instead of the real backend so
      // any SSR fetch that escapes MSW fails loudly with ECONNREFUSED rather
      // than silently hitting a developer's locally running Fastify on 9000.
      // Use a Fetch-allowed port: blocked "bad ports" fail before MSW can
      // intercept the request.
      // MSW Node registers handlers against this URL via getJson() and
      // intercepts before the socket dial, so reachability is irrelevant for
      // the happy path.
      ARCHESTRA_INTERNAL_API_BASE_URL: "http://127.0.0.1:65535",
      NEXT_PUBLIC_SENTRY_DSN: "",
    },
  },
});
