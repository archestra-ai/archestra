import fs from "node:fs";
import { defineConfig } from "@playwright/test";
import { adminAuthFile, UI_BASE_URL } from "../consts";

/**
 * Standalone Playwright config for the `archestra-dev-smoke` skill's visual capture.
 *
 * Deliberately separate from the main `playwright.config.ts`: a single chromium project, no
 * setup-chain dependency, and screenshots taken explicitly (not on failure). It reuses the
 * already-installed `@playwright/test` and the e2e-tests auth helpers, but `pnpm test:e2e`
 * never picks this up because it lives outside `testDir: ./tests`.
 *
 * Auth: reuse the admin storageState produced by a prior `pnpm test:e2e` run when present;
 * otherwise the capture test signs in itself via `loginViaApi` (the file is gitignored and
 * absent on a clean checkout, so the fallback is the common case).
 *
 * Run from `platform/e2e-tests/`:
 *   SMOKE_PATHS=/agents,/settings pnpm exec playwright test --config smoke/smoke.config.ts
 */
export default defineConfig({
  testDir: __dirname,
  testMatch: /capture\.smoke\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  reporter: "line",
  use: {
    baseURL: UI_BASE_URL,
    navigationTimeout: 60_000,
    actionTimeout: 15_000,
    storageState: fs.existsSync(adminAuthFile) ? adminAuthFile : undefined,
  },
});
