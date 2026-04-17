import path from "node:path";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

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
    // JSDOM-heavy frontend tests need a larger worker heap on Node 24.
    pool: "forks",
    execArgv: ["--max-old-space-size=8192"],
    // CI runs backend and frontend tests in parallel, so keep jsdom worker pressure low.
    maxConcurrency: 2,
  },
});
