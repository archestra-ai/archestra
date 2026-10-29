import { defineConfig } from "vitest/config";
import base from "./vitest.config";

/** Opt-in benchmarks reuse the real database test harness, outside normal CI. */
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    maxWorkers: 1,
    projects: [
      {
        extends: true,
        test: {
          name: "query-performance",
          include: ["benchmarks/**/*.bench.ts"],
          isolate: true,
          globalSetup: ["./src/test/global-setup.ts"],
          setupFiles: ["./src/test/setup.ts"],
        },
      },
    ],
  },
});
