import { defineConfig, devices } from "@playwright/test";
import { adminAuthFile, IS_CI } from "./consts";

/**
 * Project names for dependency references
 */
const projectNames = {
  setupAdmin: "setup-admin",
  setupUsers: "setup-users",
  setupTeams: "setup-teams",
  credentialsWithVault: "credentials-with-vault",
  chromium: "chromium",
  firefox: "firefox",
  webkit: "webkit",
  sso: "sso",
  api: "api",
};

/**
 * Test file patterns for project configuration
 */
const testPatterns = {
  // Setup files
  adminSetup: /auth\.admin\.setup\.ts/,
  usersSetup: /auth\.users\.setup\.ts/,
  teamsSetup: /auth\.teams\.setup\.ts/,
  // Special test files that need isolated execution
  credentialsWithVault: /credentials-with-vault\.ee\.spec\.ts/,
  // NOTE: File was renamed to .ee.spec.ts in commit f10027e (move SSO logic to .ee files)
  ssoProviders: /sso-providers\.ee\.spec\.ts/,
};

/**
 * Tests to ignore in standard browser projects (chromium, firefox, webkit).
 * These tests run in their own dedicated projects for isolation.
 */
const browserTestIgnore = [
  testPatterns.credentialsWithVault,
  testPatterns.ssoProviders,
];

/**
 * Common dependency configurations
 */
const dependencies = {
  // Browser projects depend on credentials-with-vault completing first
  browserProjects: [projectNames.credentialsWithVault],
  // SSO tests run after all browser UI tests to avoid parallel execution issues
  ssoProject: [
    projectNames.chromium,
    projectNames.firefox,
    projectNames.webkit,
  ],
  // API tests only need authentication setup, not the full UI test suite
  apiProject: [projectNames.setupTeams],
};

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: "./tests",
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: IS_CI,
  /* Retry on CI only */
  retries: IS_CI ? 2 : 0,
  /* Reduce workers in CI to avoid resource contention */
  workers: IS_CI ? 18 : 3,
  /* Global timeout for each test */
  timeout: 60_000,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: IS_CI ? [["html"], ["line"]] : "line",
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: "retain-on-failure",
    /* Record video only when test fails */
    video: "retain-on-failure",
    /* Take screenshot only when test fails */
    screenshot: "only-on-failure",
    /* Timeout for each action (click, fill, etc.) */
    actionTimeout: 15_000,
    /* Timeout for navigation actions */
    navigationTimeout: 30_000,
  },
  /* Expect timeout for assertions */
  expect: {
    timeout: 10_000,
  },

  /* Configure projects for major browsers */
  projects: [
    // Setup projects - run authentication in correct order
    {
      name: projectNames.setupAdmin,
      testMatch: testPatterns.adminSetup,
      testDir: "./",
    },
    {
      name: projectNames.setupUsers,
      testMatch: testPatterns.usersSetup,
      testDir: "./",
      // Users setup needs admin to be authenticated first
      dependencies: [projectNames.setupAdmin],
    },
    {
      name: projectNames.setupTeams,
      testMatch: testPatterns.teamsSetup,
      testDir: "./",
      // Teams setup needs users to be created first
      dependencies: [projectNames.setupUsers],
    },
    // This runs first and by default we use Vault as secrets manager
    // At the end of this test we switch to DB as secrets manager because all other tests rely on it
    {
      name: projectNames.credentialsWithVault,
      testMatch: testPatterns.credentialsWithVault,
      testDir: "./tests/ui",
      use: {
        ...devices["Desktop Chrome"],
        // Use the stored authentication state
        storageState: adminAuthFile,
      },
      // Run all setup projects before tests
      dependencies: [projectNames.setupTeams],
    },
    // UI tests run on all browsers
    // Note: SSO tests are excluded here and run in a separate project to avoid
    // parallel execution issues (they manipulate shared backend state like SSO providers)
    {
      name: projectNames.chromium,
      testDir: "./tests/ui",
      testIgnore: browserTestIgnore,
      use: {
        ...devices["Desktop Chrome"],
        // Use the stored authentication state
        storageState: adminAuthFile,
      },
      // Run all setup projects before tests
      dependencies: dependencies.browserProjects,
    },
    {
      name: projectNames.firefox,
      testDir: "./tests/ui",
      testIgnore: browserTestIgnore,
      use: {
        ...devices["Desktop Firefox"],
        // Use the stored authentication state
        storageState: adminAuthFile,
      },
      // Run all setup projects before tests
      dependencies: dependencies.browserProjects,
      grep: /@firefox/,
    },
    {
      name: projectNames.webkit,
      testDir: "./tests/ui",
      testIgnore: browserTestIgnore,
      use: {
        ...devices["Desktop Safari"],
        // Use the stored authentication state
        storageState: adminAuthFile,
      },
      // Run all setup projects before tests
      dependencies: dependencies.browserProjects,
      grep: /@webkit/,
    },
    // SSO tests run AFTER all other UI tests complete to avoid parallel execution issues
    // These tests manipulate shared backend state (SSO providers, Keycloak) and need isolation
    // IMPORTANT: SSO tests do NOT use storageState because:
    // 1. SSO logins can invalidate the admin session stored in adminAuthFile
    // 2. Each SSO test needs to authenticate fresh to avoid session conflicts
    // 3. The ensureAdminAuthenticated() helper handles login at the start of each test
    {
      name: projectNames.sso,
      testDir: "./tests/ui",
      testMatch: testPatterns.ssoProviders,
      use: {
        ...devices["Desktop Chrome"],
        // No storageState - SSO tests authenticate fresh via ensureAdminAuthenticated()
      },
      // Run after all browser UI tests complete - ensures exclusive access to SSO resources
      dependencies: dependencies.ssoProject,
    },
    // API tests only run on chromium (browser doesn't matter for API integration tests)
    // API tests only need authentication setup, not the full UI test suite
    {
      name: projectNames.api,
      testDir: "./tests/api",
      use: {
        ...devices["Desktop Chrome"],
        // Use the stored authentication state
        storageState: adminAuthFile,
      },
      // Only depend on auth setup, not UI tests
      dependencies: dependencies.apiProject,
    },
  ],
});
