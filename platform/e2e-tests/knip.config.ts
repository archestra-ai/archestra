import type { KnipConfig } from "knip";

const config: KnipConfig = {
  entry: ["tests/**/*.ts", "auth.*.setup.ts", "consts.ts"],
  project: ["**/*.{ts,mts}"],
  ignoreDependencies: [
    // Workspace dependency - resolved by pnpm
    "@archestra/shared",
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
