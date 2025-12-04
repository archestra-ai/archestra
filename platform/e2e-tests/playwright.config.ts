import { defineConfig, devices } from "@playwright/test";
import { adminAuthFile } from "./consts";

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: "./tests",
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  workers: 3,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: process.env.CI ? "html" : "line",
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: "retain-on-failure",
    /* Record video only when test fails */
    video: "retain-on-failure",
    /* Take screenshot only when test fails */
    screenshot: "only-on-failure",
  },

  /* Configure projects for major browsers */
  projects: [
    // Setup projects - run authentication in correct order
    {
      name: "setup-admin",
      testMatch: /auth\.admin\.setup\.ts/,
      testDir: "./",
    },
    {
      name: "setup-users",
      testMatch: /auth\.users\.setup\.ts/,
      testDir: "./",
      // Users setup needs admin to be authenticated first
      dependencies: ["setup-admin"],
    },
    {
      name: "setup-teams",
      testMatch: /auth\.teams\.setup\.ts/,
      testDir: "./",
      // Teams setup needs users to be created first
      dependencies: ["setup-users"],
    },
    // API tests only run on chromium (browser doesn't matter for API integration tests)
    {
      name: "api",
      testDir: "./tests/api",
      use: {
        ...devices["Desktop Chrome"],
        // Use the stored authentication state
        storageState: adminAuthFile,
      },
      // Run all setup projects before tests
      dependencies: ["setup-teams"],
    },
    // UI tests run on all browsers
    {
      name: "chromium",
      testDir: "./tests/ui",
      use: {
        ...devices["Desktop Chrome"],
        // Use the stored authentication state
        storageState: adminAuthFile,
      },
      // Run all setup projects before tests
      dependencies: ["setup-teams"],
    },
    {
      name: "firefox",
      testDir: "./tests/ui",
      use: {
        ...devices["Desktop Firefox"],
        // Use the stored authentication state
        storageState: adminAuthFile,
      },
      // Run all setup projects before tests
      dependencies: ["setup-teams"],
      grep: /@firefox/,
    },
    {
      name: "webkit",
      testDir: "./tests/ui",
      use: {
        ...devices["Desktop Safari"],
        // Use the stored authentication state
        storageState: adminAuthFile,
      },
      // Run all setup projects before tests
      dependencies: ["setup-teams"],
      grep: /@webkit/,
    },
  ],
});
