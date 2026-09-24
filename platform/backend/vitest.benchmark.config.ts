import { defineConfig } from "vitest/config";
import backendConfig from "./vitest.config";

export default defineConfig({
  ...backendConfig,
  test: {
    ...backendConfig.test,
    projects: [
      {
        extends: true,
        test: {
          name: "session-storage-benchmark",
          include: ["../benchmarks/session-storage.test.ts"],
          isolate: false,
          globalSetup: ["./src/test/global-setup.ts"],
          setupFiles: ["./src/test/setup.ts"],
          env: { ARCHESTRA_TEST_SHARED_WORKERS: "true" },
        },
      },
    ],
  },
});
