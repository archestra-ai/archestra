import { defineConfig } from "@playwright/test";
import { ARCHESTRA_URL, PERSONA_AUTH_FILE } from "./src/env";

/**
 * `seed` signs in as the instance admin, seeds the demo organization, and signs
 * the persona in; `capture` then renders every manifest shot in both themes.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  retries: 1,
  reporter: [["list"]],
  timeout: 90_000,
  use: {
    baseURL: ARCHESTRA_URL,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    locale: "en-US",
    timezoneId: "UTC",
    contextOptions: { reducedMotion: "reduce" },
  },
  projects: [
    { name: "seed", testMatch: /seed\.setup\.ts/ },
    {
      name: "capture",
      testMatch: /capture\.spec\.ts/,
      dependencies: ["seed"],
      use: { storageState: PERSONA_AUTH_FILE },
    },
  ],
});
