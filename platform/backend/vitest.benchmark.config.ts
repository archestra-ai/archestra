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
          globalSetup: [],
        },
      },
    ],
  },
});
