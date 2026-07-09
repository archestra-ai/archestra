import path from "node:path";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      // Explicit absolute-path alias (tsconfigPaths also provides "@/", but
      // Vitest's Jest-style __mocks__ sibling resolution only works reliably
      // through resolve.alias — with tsconfig-paths-only aliasing it silently
      // falls back to automocking (vitest-dev/vitest#8343).
      "@": path.resolve(__dirname, "./src"),
      "@archestra/shared/access-control": path.resolve(
        __dirname,
        "../shared/access-control.ts",
      ),
      "@archestra/shared": path.resolve(__dirname, "../shared/index.ts"),
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
    // Each fork is a separate process with the heap ceiling above, so worker
    // count multiplies memory. Cap at half the cores so this suite doesn't
    // exhaust RAM when it runs alongside the shared/type-check/lint tasks —
    // locally via `turbo test`, and in CI where `check:ci` stacks them on one
    // runner (which has shown orphaned fork workers when uncapped).
    maxWorkers: "50%",
    // Caps concurrent `test.concurrent` cases within a single file (plain
    // sequential test() is unaffected). Kept as a low guardrail so a future
    // concurrent suite can't pile jsdom work into one worker; worker count is
    // capped separately by maxWorkers above.
    maxConcurrency: 2,
  },
});
