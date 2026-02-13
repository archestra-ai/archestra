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
  identityProviders: "identity-providers",
  api: "api",
  vaultK8s: "vault-k8s",
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
  identityProviders: /identity-providers\.ee\.spec\.ts/,
  // Vault K8s startup test — runs in a dedicated CI job with Vault K8s auth
  vaultK8s: /vault-k8s-startup\.spec\.ts/,
};

/**
 * Tests to ignore in standard browser projects (chromium, firefox, webkit).
 * These tests run in their own dedicated projects for isolation.
 */
const browserTestIgnore = [
  testPatterns.credentialsWithVault,
  testPatterns.identityProviders,
  testPatterns.vaultK8s,
];

/**
 * Common dependency configurations
 *
 * IMPORTANT: For sharding to work correctly, all test projects must depend
 * only on setup projects, NOT on other test projects. This allows Playwright
 * to distribute test files across shards without pulling in entire project chains.
 *
 * The setup-teams project is the final setup step that all tests depend on.
 * Previously, we had inter-test dependencies (chromium → credentials-with-vault → identity-providers → api)
 * which caused each shard to run the same tests.
 */
const dependencies = {
  // All test projects depend only on setup completion
  testProjects: [projectNames.setupTeams],
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
  workers: IS_CI ? 12 : 3,
  /* Global timeout for each test */
  timeout: 60_000,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: IS_CI ? [["blob"], ["github"], ["line"]] : "line",
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
    // Vault integration tests - tests BYOS (Bring Your Own Secrets) with HashiCorp Vault
    // Note: This test file manages its own secrets manager state (switches to Vault, then back to DB)
    {
      name: projectNames.credentialsWithVault,
      testMatch: testPatterns.credentialsWithVault,
      testDir: "./tests/ui",
      use: {
        ...devices["Desktop Chrome"],
        storageState: adminAuthFile,
      },
      dependencies: dependencies.testProjects,
    },
    // Main UI tests on Chrome
    {
      name: projectNames.chromium,
      testDir: "./tests/ui",
      testIgnore: browserTestIgnore,
      use: {
        ...devices["Desktop Chrome"],
        storageState: adminAuthFile,
      },
      dependencies: dependencies.testProjects,
    },
    // Firefox tests - only runs tests tagged with @firefox
    {
      name: projectNames.firefox,
      testDir: "./tests/ui",
      testIgnore: browserTestIgnore,
      use: {
        ...devices["Desktop Firefox"],
        storageState: adminAuthFile,
      },
      dependencies: dependencies.testProjects,
      grep: /@firefox/,
    },
    // WebKit tests - only runs tests tagged with @webkit
    {
      name: projectNames.webkit,
      testDir: "./tests/ui",
      testIgnore: browserTestIgnore,
      use: {
        ...devices["Desktop Safari"],
        storageState: adminAuthFile,
      },
      dependencies: dependencies.testProjects,
      grep: /@webkit/,
    },
    // Identity provider tests - manipulate shared backend state, authenticate fresh each test
    {
      name: projectNames.identityProviders,
      testDir: "./tests/ui",
      testMatch: testPatterns.identityProviders,
      use: {
        ...devices["Desktop Chrome"],
        // No storageState - identity provider tests authenticate fresh via ensureAdminAuthenticated()
      },
      dependencies: dependencies.testProjects,
    },
    // API integration tests
    {
      name: projectNames.api,
      testDir: "./tests/api",
      testIgnore: [testPatterns.vaultK8s],
      use: {
        ...devices["Desktop Chrome"],
        storageState: adminAuthFile,
      },
      dependencies: dependencies.testProjects,
    },
    // Vault K8s startup test — validates platform starts with DB URL from Vault via K8s auth
    {
      name: projectNames.vaultK8s,
      testMatch: testPatterns.vaultK8s,
      testDir: "./tests/api",
      use: {
        ...devices["Desktop Chrome"],
        storageState: adminAuthFile,
      },
      dependencies: dependencies.testProjects,
    },
  ],
});
