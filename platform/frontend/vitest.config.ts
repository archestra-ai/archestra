import path from "node:path";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

const isCI = process.env.CI === "true";

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      "@shared/access-control": path.resolve(
        __dirname,
        "../shared/access-control.ts",
      ),
      "@shared": path.resolve(__dirname, "../shared/index.ts"),
    },
  },
  test: {
    globals: true,
    include: ["./src/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["./vitest-setup.ts"],
    testTimeout: 10_000,
    // Keep concurrency moderate to avoid suite-level timeouts from React/Radix-heavy tests.
    maxConcurrency: isCI ? 6 : 3,
  },
});
