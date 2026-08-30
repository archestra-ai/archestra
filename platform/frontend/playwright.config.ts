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
const CI_SHARD = process.env.ARCHESTRA_FRONTEND_INT_TESTS_SHARD;
const CI_SHARD_SUFFIX = CI_SHARD ? `-shard-${CI_SHARD}` : "";

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
  // Tests within one shard share a Next.js server with a process-global MSW
  // handler list and must remain serial. CI runs four Playwright processes in
  // two runner groups, each with its own port, Next dist directory, and output
  // directory, so the shards overlap without leaking handler overrides.
  fullyParallel: false,
  workers: 1,
  forbidOnly: IS_CI,
  retries: IS_CI ? 2 : 0,
  // Generous timeouts: the suite runs against `next dev`, which compiles each
  // route on first request and re-renders lazily. On loaded CI runners that
  // cold path routinely exceeds a 10s assertion budget (the same render is
  // near-instant locally), so the first test to touch a route would flake.
  timeout: 90_000,
  reporter: IS_CI
    ? [
        ["github"],
        [
          "html",
          {
            open: "never",
            outputFolder: `playwright-report${CI_SHARD_SUFFIX}`,
          },
        ],
      ]
    : [["list"], ["html", { open: "never" }]],
  outputDir: `test-results${CI_SHARD_SUFFIX}`,
  use: {
    baseURL: INT_TESTS_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
  },
  expect: { timeout: 30_000 },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `next dev -H 127.0.0.1 -p ${INT_TESTS_PORT}`,
    url: INT_TESTS_URL,
    reuseExistingServer: !IS_CI,
    timeout: 120_000,
    env: {
      // Same dist dir the Tilt-managed int-tests frontend uses
      // (dev/Tiltfile.dev). Without it, a self-started server would share
      // `.next` with the main `pnpm dev` server — since Next 16.3 that fails
      // outright on the `.next/dev/lock` single-instance guard.
      NEXT_DIST_DIR: `.next-pw${CI_SHARD_SUFFIX}`,
      NEXT_PUBLIC_API_MOCKING: "enabled",
      // Server components resolve their SDK base URL from this variable, so
      // pointing it at the mock backend route turns every SSR call into an
      // ordinary HTTP request answered from the MSW handler chain. It replaces
      // in-process interception, which did not reliably survive `next dev`
      // route compiles: a server component whose fetch escaped the patched
      // globals fell through to the real backend origin, and a swallowed
      // failure then rendered as a wrong page rather than an error. Nothing
      // here can escape — an unmocked endpoint 501s and is reported by the
      // fixture's coverage guard.
      ARCHESTRA_INTERNAL_API_BASE_URL: `${INT_TESTS_URL}/internal-test/api`,
      NEXT_PUBLIC_SENTRY_DSN: "",
    },
  },
});
