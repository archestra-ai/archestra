import { defineConfig, devices } from '@playwright/test';
import path from 'path';

const authFile = path.join(__dirname, 'playwright/.auth/user.json');

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './tests',
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  workers: 3,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: process.env.CI ? 'html' : 'line',
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'retain-on-failure',
    /* Record video only when test fails */
    video: 'retain-on-failure',
    /* Take screenshot only when test fails */
    screenshot: 'only-on-failure',
  },

  /* Configure projects for major browsers */
  projects: [
    // Setup project - runs authentication once before all tests
    {
      name: 'setup',
      testMatch: /.*\.setup\.ts/,
      testDir: './',
    },
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Use the stored authentication state
        storageState: authFile,
      },
      // Run the setup project before tests
      dependencies: ['setup'],
    },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        // Use the stored authentication state
        storageState: authFile,
      },
      // Run the setup project before tests
      dependencies: ['setup'],
    },
    {
      name: 'webkit',
      use: {
        ...devices['Desktop Safari'],
        // Use the stored authentication state
        storageState: authFile,
      },
      // Run the setup project before tests
      dependencies: ['setup'],
    },
  ],
});
