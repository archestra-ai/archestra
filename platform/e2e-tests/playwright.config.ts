// NOTE: nothing under e2e-tests/ is part of the platform Docker image — CI's
// image-reuse key deliberately excludes this directory, so e2e-only changes
// reuse the previously built image instead of rebuilding it (see the
// "Resolve platform image reuse" step in .github/workflows/platform-e2e-tests.yml).
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
  quickstart: "quickstart",
  quickstartRecovery: "quickstart-recovery",
  chromium: "chromium",
  firefox: "firefox",
  webkit: "webkit",
  identityProviders: "identity-providers",
  identityProvidersSaml: "identity-providers-saml",
  api: "api",
  apiK8s: "api-k8s",
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  apiK8sHibernation: "api-k8s-hibernation",
  // SPDX-SnippetEnd
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
  quickstart: "**/quickstart.spec.ts",
  // Special test files that need isolated execution
  credentialsWithVault: "**/credentials-with-vault.ee.spec.ts",
  identityProviders: "**/identity-providers.ee.spec.ts",
  // Vault K8s startup test — runs in a dedicated CI job with Vault K8s auth
  vaultK8s: "**/vault-k8s-startup.spec.ts",
  llmProxy: "**/llm-proxy/**/*.spec.ts",
};

const uiTestMatch = [
  "**/agent-version-history.spec.ts",
  "**/agents.spec.ts",
  "**/apps.spec.ts",
  "**/audit-log.spec.ts",
  "**/auth-origin.spec.ts",
  "**/auth-redirect.spec.ts",
  "**/chat-browser-setup.spec.ts",
  "**/chat-message-queue.spec.ts",
  "**/chat-permissions.spec.ts",
  "**/chat-refresh.spec.ts",
  "**/chat.spec.ts",
  "**/context-window.spec.ts",
  "**/connection.spec.ts",
  "**/credentials-with-vault.ee.spec.ts",
  "**/dynamic-credentials.spec.ts",
  "**/identity-providers.ee.spec.ts",
  "**/invitation.spec.ts",
  "**/llm-logs-slack-source.spec.ts",
  "**/loading-states.spec.ts",
  "**/mcp-edit.spec.ts",
  "**/mcp-install.spec.ts",
  "**/model-limits.spec.ts",
  "**/quickstart.spec.ts",
  "**/skill-share.spec.ts",
  "**/skill-version-history.spec.ts",
  "**/skills-bulk-actions.spec.ts",
  "**/static-credentials-management.spec.ts",
  "**/tool-guardrails.spec.ts",
  "**/users-role-filter.spec.ts",
];

// API specs that run in the lite environment (platform as a plain container
// with WireMock/Keycloak sidecars). MCP-server installs work there too: the
// quickstart entrypoint provisions an embedded Kind cluster for the
// orchestrator.
const apiTestMatch = [
  "**/a2a-public-origin.spec.ts",
  "**/built-in-agents.spec.ts",
  "**/chat-api.spec.ts",
  "**/knowledge-permission-sync.spec.ts",
  "**/custom-yaml-restart.spec.ts",
  "**/mcp-gateway-jwks-credential-priority.ee.spec.ts",
  "**/mcp-gateway-jwks.ee.spec.ts",
  "**/orchestrator.spec.ts",
  testPatterns.llmProxy,
];

// API specs that genuinely need the Kind+Helm CI environment: host-cluster
// kubectl access (image-pull-secrets), NetworkPolicy enforcement (ssrf,
// jwt-propagation), or helm-deployed fixture servers (oauth-self-hosted,
// enterprise-managed). Everything else belongs in apiTestMatch above.
// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// Idle hibernation also needs a host cluster but has its own project below:
// it flips the organization-wide toggle and waits out real idle windows, so
// it can neither share workers with specs that own MCP servers of their own
// nor fit the budget this leg is sized for.
// SPDX-SnippetEnd
const apiK8sTestMatch = [
  "**/image-pull-secrets.spec.ts",
  "**/mcp-enterprise-managed.ee.spec.ts",
  "**/mcp-gateway-jwt-propagation.ee.spec.ts",
  "**/oauth-self-hosted.spec.ts",
  "**/ssrf-protection.spec.ts",
];

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// Every idle-hibernation spec. Run serially in their own CI leg: one of them
// turns the organization-wide toggle on to exercise the real sweeper, which
// would otherwise be free to hibernate a sibling spec's server mid-test.
const hibernationTestMatch = [
  "**/mcp-hibernation.spec.ts",
  "**/mcp-hibernation-capacity.spec.ts",
  "**/mcp-hibernation-recovery.spec.ts",
  "**/mcp-hibernation-topology.spec.ts",
];
// SPDX-SnippetEnd

const quickstartTestMatch = [
  "**/auth-origin.spec.ts",
  "**/mcp-install.spec.ts",
  "**/quickstart.spec.ts",
];

/**
 * Tests to ignore in standard browser projects (chromium, firefox, webkit).
 * These tests run in their own dedicated projects for isolation.
 */
const browserTestIgnore = [
  testPatterns.credentialsWithVault,
  testPatterns.identityProviders,
  testPatterns.quickstart,
  testPatterns.llmProxy,
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
  workers: IS_CI ? "90%" : 3,
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
      testDir: "./tests",
      use: {
        ...devices["Desktop Chrome"],
        storageState: adminAuthFile,
      },
      dependencies: dependencies.testProjects,
    },
    // SAML is kept executable but off the merge queue until its previously
    // quarantined Keycloak flow has a green scheduled/manual history.
    {
      name: projectNames.identityProvidersSaml,
      testDir: "./tests",
      testMatch: testPatterns.identityProviders,
      grep: /@saml/,
      use: {
        ...devices["Desktop Chrome"],
      },
      dependencies: dependencies.testProjects,
    },
    {
      name: projectNames.quickstart,
      testDir: "./tests",
      testMatch: quickstartTestMatch,
      use: {
        ...devices["Desktop Chrome"],
        storageState: adminAuthFile,
      },
      dependencies: dependencies.testProjects,
      grepInvert: /@k8s-recovery/,
    },
    // Recovery against a deliberately broken image is valuable but has a
    // documented cluster deletion race. Keep it executable on scheduled and
    // manual runs without putting that flake back on the merge queue.
    {
      name: projectNames.quickstartRecovery,
      testDir: "./tests",
      testMatch: quickstartTestMatch,
      grep: /@k8s-recovery/,
      use: {
        ...devices["Desktop Chrome"],
        storageState: adminAuthFile,
      },
      dependencies: dependencies.testProjects,
    },
    // Main UI tests on Chrome
    {
      name: projectNames.chromium,
      testDir: "./tests",
      testMatch: uiTestMatch,
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
      testDir: "./tests",
      testMatch: uiTestMatch,
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
      testDir: "./tests",
      testMatch: uiTestMatch,
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
      testDir: "./tests",
      testMatch: testPatterns.identityProviders,
      use: {
        ...devices["Desktop Chrome"],
        // No storageState - identity provider tests authenticate fresh via ensureAdminAuthenticated()
      },
      dependencies: dependencies.testProjects,
      grepInvert: /@saml/,
    },
    // API integration tests (lite environment)
    {
      name: projectNames.api,
      testDir: "./tests",
      testMatch: apiTestMatch,
      use: {
        ...devices["Desktop Chrome"],
        storageState: adminAuthFile,
      },
      dependencies: dependencies.testProjects,
    },
    // API integration tests that need the Kind+Helm CI environment
    {
      name: projectNames.apiK8s,
      testDir: "./tests",
      testMatch: apiK8sTestMatch,
      use: {
        ...devices["Desktop Chrome"],
        storageState: adminAuthFile,
      },
      dependencies: dependencies.testProjects,
    },
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    // Idle hibernation against a real cluster: sweeper, wake, capacity,
    // topology and administrator recovery.
    {
      name: projectNames.apiK8sHibernation,
      testDir: "./tests",
      testMatch: hibernationTestMatch,
      // One retry, not the global two: these specs run serially and re-run
      // their heavyweight fixtures (a cold pod install alone approaches
      // 7 min) on every retry, so the global setting can push one genuinely
      // bad file past the CI step budget — the run then reports as a timeout
      // with no artifacts instead of as results.
      retries: IS_CI ? 1 : 0,
      use: {
        ...devices["Desktop Chrome"],
        storageState: adminAuthFile,
      },
      dependencies: dependencies.testProjects,
    },
    // SPDX-SnippetEnd
    // Vault K8s startup test — validates platform starts with DB URL from Vault via K8s auth
    {
      name: projectNames.vaultK8s,
      testMatch: testPatterns.vaultK8s,
      testDir: "./tests",
      use: {
        ...devices["Desktop Chrome"],
        storageState: adminAuthFile,
      },
      dependencies: dependencies.testProjects,
    },
  ],
});
