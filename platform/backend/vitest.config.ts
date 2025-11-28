import path from "node:path";
import { defineConfig } from "vitest/config";

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
  },
});
