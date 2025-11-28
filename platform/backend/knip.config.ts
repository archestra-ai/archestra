import type { KnipConfig } from "knip";

const config: KnipConfig = {
  entry: [
    "src/server.ts",
    "src/**/*.test.ts",
    "src/standalone-scripts/**/*.ts",
    "drizzle.config.ts",
    "tsdown.config.ts",
    "vitest.config.ts",
  ],
  project: ["src/**/*.ts"],
  ignore: [
    "src/**/*.test.ts",
    "src/database/migrations/**",
  ],
  ignoreDependencies: [
    // Drizzle migrations are generated
    "drizzle-kit",
    // Test dependencies
    "@electric-sql/pglite",
  ],
};

export default config;

