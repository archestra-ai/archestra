import path from "node:path";
import { defineConfig } from "vitest/config";

const isCI = process.env.CI === "true";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    globals: true,
    include: ["./src/**/*.test.ts"],
    environment: "node",
    setupFiles: ["./src/test/setup.ts"],
    // Increase concurrency on CI (8 vCPU runner) for faster test execution
    // Default is 5, CI can handle more parallel tests
    maxConcurrency: isCI ? 10 : 5,
  },
});
