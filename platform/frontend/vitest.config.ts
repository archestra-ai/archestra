import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

const isCI = process.env.CI === "true";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    include: ["./src/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["./vitest-setup.ts"],
    // Increase concurrency on CI for faster test execution
    // Default is 5, CI can handle more parallel tests
    maxConcurrency: isCI ? 10 : 5,
  },
});
