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
  ignore: ["src/**/*.test.ts", "src/database/migrations/**"],
  ignoreDependencies: [
    // Workspace dependency - resolved by pnpm
    "@shared",
    // Used in logging.ts
    "pino-pretty",
  ],
  ignoreBinaries: [
    // biome is in root package.json
    "biome",
  ],
  rules: {
    // Types/schemas are exported for API documentation and external client generation
    exports: "off",
    types: "off",
  },
};

export default config;
