import type { KnipConfig } from "knip";

const config: KnipConfig = {
  entry: ["hey-api/**/*.ts", "themes/**/*.ts"],
  project: ["**/*.ts"],
  ignore: [],
  ignoreDependencies: [
    // Provides tsc, which scripts/type-check.ts runs for `pnpm type-check`.
    "typescript-7",
  ],
  ignoreBinaries: [
    // biome, concurrently, and tsx are in the workspace root package.json
    "biome",
    "concurrently",
    "tsx",
  ],
};

export default config;
