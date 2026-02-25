import type { KnipConfig } from "knip";

const config: KnipConfig = {
  entry: ["src/**/*.test.ts", "src/standalone-scripts/**/*.ts"],
  project: ["src/**/*.ts", "*.config.ts"],
  ignore: ["src/**/*.test.ts", "src/database/migrations/**"],
  ignoreDependencies: [
    // Workspace dependency - resolved by pnpm
    "@shared",
    // Used as a binary in scripts and Sentry source maps upload
    "@sentry/cli",
    // Used as a binary in scripts
    "tsx",
  ],
  ignoreBinaries: [
    // biome and concurrently are in root package.json
    "biome",
    "concurrently",
    // Provided by devDependencies but knip doesn't resolve in pnpm monorepo
    "tsdown",
    "vitest",
    "knip",
    "tsc",
    "drizzle-kit",
    "tsx",
    "sentry-cli",
  ],
  rules: {
    // Types/schemas are exported for API documentation and external client generation
    exports: "off",
    types: "off",
  },
};

export default config;
